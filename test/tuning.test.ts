import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Controller } from '../src/controller.js';
import type { DashboardState } from '../src/types.js';
import { excerptObservation, rankCandidates } from '../src/tuning.js';
import { Workspace } from '../src/workspace.js';

function state(root: string): DashboardState {
  return { mode: 'test', task: 'Fix z-target.ts', workspace: root, status: 'Working',
    executiveModel: 'test', system1Model: 'test', hz: 2, frames: 0, skipped: 0, reflexes: 0,
    escalations: 0, inputTokens: 0, lastLatencyMs: 0, probabilities: {}, events: [], answer: '' };
}

test('bounded observations retain a traceback location instead of only a file prefix', () => {
  const lines = Array.from({ length: 1000 }, (_, index) => `source line ${index + 1}`);
  lines[686] = 'if broken_condition:';
  const excerpt = excerptObservation('src/rewrite.py', lines.join('\n'), 1024, 'Crash at src/rewrite.py:687');
  assert.match(excerpt.content, /if broken_condition:/);
  assert.ok(excerpt.content.length <= 1024);
  assert.equal(excerpt.content.split('\n')[687 - excerpt.startLine], 'if broken_condition:');
  assert.equal(excerpt.truncated, true);
});

test('the perception board retains evidence from both large files and delivers it once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ros-board-'));
  const controller = new Controller(new Workspace(root), state(root), async snapshot => ({
    action: 'read_related_file', target: snapshot.candidates[0], targetProbability: 0.99,
    probability: 0.99, probabilities: { read_related_file: 0.99 }, inputTokens: 1,
  }), undefined, 0.85, { boardChars: 1024, reflexChain: 1 });
  t.after(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'implementation.ts'), 'const implementation = 1;\n'.repeat(100));
  await writeFile(join(root, 'regression.test.ts'), 'const regression = 1;\n'.repeat(100));
  await controller.prime();
  const delivered = controller.takeBoard().observations;
  assert.equal(delivered.length, 2);
  assert.ok(delivered.every(item => item.content.length > 0 && item.truncated));
  assert.ok(delivered.reduce((sum, item) => sum + item.content.length, 0) <= 1024);
  assert.equal(controller.takeBoard().observations.length, 0);
});

test('unchanged timer frames do not spend inference; edits and new tool evidence do', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ros-tuning-'));
  const dashboard = state(root);
  let calls = 0;
  const controller = new Controller(new Workspace(root), dashboard, async () => {
    calls++;
    return { action: 'wait', probability: 0.99, probabilities: { wait: 0.99 }, inputTokens: 10 };
  });
  t.after(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'z-target.ts'), 'first');
  await controller.sample('startup');
  for (let index = 0; index < 5; index++) await controller.sample('timer');
  assert.equal(calls, 1);
  await writeFile(join(root, 'z-target.ts'), 'a changed source');
  await controller.sample('timer');
  assert.equal(calls, 2);
  await controller.tool('read_file', { path: 'z-target.ts' });
  assert.equal(calls, 3);
});

test('candidate ranking reaches source beyond the old first 100 files; search is read-only', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ros-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 120 }, (_, i) => writeFile(join(root, `a-${i}.ts`), 'unrelated')));
  await writeFile(join(root, 'z-target.ts'), 'export const target = 1;\n');
  const workspace = new Workspace(root);
  const files = await workspace.list();
  assert.equal(files.length, 121);
  assert.equal(rankCandidates(files, 'Fix z-target.ts', null)[0], 'z-target.ts');
  assert.equal((await workspace.search('target')).matches[0]?.path, 'z-target.ts');
  await assert.rejects(workspace.replace('z-target.ts', '1', '2'), /Read the file/);
  await workspace.read('z-target.ts');
  await workspace.replace('z-target.ts', '1', '2');
  assert.match((await workspace.read('z-target.ts')).content, /target = 2/);
  await assert.rejects(workspace.replace('z-target.ts', 'missing', '3'), /exactly once/);
});

test('disabled System 1 does not call a classifier and preserves executive tools', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ros-disabled-'));
  const controller = new Controller(new Workspace(root, 'true'), state(root), async () => { throw new Error('Must not run'); }, undefined, 0.85, { enabled: false });
  t.after(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });
  await controller.sample('startup');
  await controller.tool('run_checks', {});
  assert.equal(controller.board().enabled, false);
  assert.equal(controller.board().lastCheck?.exitCode, 0);
});
