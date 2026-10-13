import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Controller } from '../src/controller.js';
import { chunkFile, defaultLocalizeOptions, formatChunks, indexWorkspace, localize, selectChunks, type Chunk, type Scorer } from '../src/localize.js';
import type { DashboardState } from '../src/types.js';
import { Workspace } from '../src/workspace.js';

const source = [
  'import os', '', 'class Parser:', '    """Parse things."""', '', '    @property', '    def name(self):', '        return "p"', '',
  '    def is_docstring(self, item):', '        return isinstance(item.value, str)', '', 'def unrelated():', '    return 1', '',
].join('\n');

function state(root: string, task: string): DashboardState {
  return { mode: 'test', task, workspace: root, status: 'Working', executiveModel: 'test', system1Model: 'test', hz: 2,
    frames: 0, skipped: 0, reflexes: 0, escalations: 0, inputTokens: 0, lastLatencyMs: 0, probabilities: {}, events: [], answer: '' };
}

// Scores by definition name so tests do not depend on model inference.
const scorer = (wanted: string): Scorer => ({
  files: async (_task, files) => ({ probabilities: files.map(file => file.path.includes('parser') ? 0.9 : 0.1), inputTokens: 5, costUsd: 0.0001 }),
  chunks: async (_task, chunks) => ({ probabilities: chunks.map(chunk => chunk.name.endsWith(wanted) ? 0.95 : 0.05), inputTokens: 7, costUsd: 0.0002 }),
});

test('chunks follow definitions, keep decorators, and qualify methods with their class', () => {
  const chunks = chunkFile('pkg/parser.py', source);
  assert.deepEqual(chunks.map(chunk => chunk.name), ['(module)', 'Parser', 'Parser.name', 'Parser.is_docstring', 'unrelated']);
  const property = chunks.find(chunk => chunk.name === 'Parser.name')!;
  assert.equal(property.startLine, 6);
  assert.match(property.text, /^    @property\n    def name/);
});

test('selection keeps whole lines within budget and respects thresholds', () => {
  const chunk = (id: string, probability: number, text: string): Chunk => ({ id, path: 'a.py', startLine: 10, endLine: 10 + text.split('\n').length - 1, name: id, text, lexical: 1, probability });
  const picked = selectChunks([chunk('low', 0.3, 'x = 1'), chunk('high', 0.9, 'line one\nline two\nline three'), chunk('mid', 0.6, 'y = 2')],
    { threshold: 0.5, floor: 0.2, budgetChars: 20, maxChunks: 4 });
  assert.deepEqual(picked.map(item => item.id), ['high']);
  assert.equal(picked[0]!.text, 'line one\nline two');
  assert.equal(picked[0]!.endLine, 11);
  assert.equal(selectChunks([chunk('weak', 0.1, 'z')], { threshold: 0.5, floor: 0.2, budgetChars: 100, maxChunks: 4 }).length, 0);
  assert.match(formatChunks(picked), /^--- a\.py lines 10-11 \(high; System 1 P\(relevant\)=0\.90\)\nline one/);
});

test('localization scores likely files, then delivers the relevant definition only', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ros-localize-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'pkg'));
  await writeFile(join(root, 'pkg/parser.py'), source);
  await writeFile(join(root, 'pkg/other.py'), 'def docstring_helper():\n    return "docstring"\n');
  const task = 'is_docstring treats a number as a docstring in Parser';
  const index = await indexWorkspace(new Workspace(root), task);
  const trace = await localize(index, task, { ...defaultLocalizeOptions, files: 8, expandFiles: 1, fileThreshold: 0.3, perFile: 8, previewLines: 20,
    threshold: 0.5, floor: 0.2, budgetChars: 2000, maxChunks: 3 }, scorer('is_docstring'), AbortSignal.timeout(1000));
  assert.deepEqual(trace.delivered.map(chunk => chunk.name), ['Parser.is_docstring']);
  assert.equal(trace.calls, 2);
  assert.ok(Math.abs(trace.costUsd! - 0.0003) < 1e-12);
});

test('controller primes the executive with localized source that is authorized for exact edits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ros-localize-controller-'));
  await mkdir(join(root, 'pkg'));
  await writeFile(join(root, 'pkg/parser.py'), source);
  const workspace = new Workspace(root, 'true');
  const board = state(root, 'is_docstring treats a number as a docstring in Parser');
  const controller = new Controller(workspace, board, async () => { throw new Error('continuous classifier must not run'); },
    undefined, 0.85, { continuous: false, localize: { expandFiles: 1 } }, scorer('is_docstring'));
  t.after(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });
  controller.beginTurn(board.task);
  controller.start();
  await controller.prime();
  const prompt = controller.takeLocalization();
  assert.match(prompt!, /pkg\/parser\.py lines 10-12 \(Parser\.is_docstring/);
  assert.equal(controller.takeLocalization(), undefined);
  assert.equal(board.frames, 2);
  assert.equal(board.events.filter(event => event.lane === 'system1' && event.kind === 'usage').length, 2);
  // No read_file call: the localized read authorizes an exact replacement.
  const edit = await controller.tool('replace_text', { path: 'pkg/parser.py', oldText: 'isinstance(item.value, str)', newText: 'isinstance(item.value, str) and bool(item.value)' }) as Record<string, unknown>;
  assert.equal((edit.result as { written: boolean }).written, true);
  assert.equal(edit.system1, undefined);
  // Files System 1 only ranked are not authorized for edits.
  await writeFile(join(root, 'pkg/other.py'), 'x = 1\n');
  const refused = await controller.tool('replace_text', { path: 'pkg/other.py', oldText: 'x = 1', newText: 'x = 2' }) as { result: { error: string } };
  assert.match(refused.result.error, /Read the file before editing/);
});
