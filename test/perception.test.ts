import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Controller } from '../src/controller.js';
import type { S1Evaluate } from '../src/monitor.js';
import type { DashboardState } from '../src/types.js';
import { Workspace } from '../src/workspace.js';

function state(root: string): DashboardState {
  return { mode: 'test', task: 'Make value 2', workspace: root, status: 'Working', executiveModel: 'test', system1Model: 'test', hz: 2,
    frames: 0, skipped: 0, reflexes: 0, escalations: 0, inputTokens: 0, lastLatencyMs: 0, probabilities: {}, events: [], answer: '' };
}

// Scripted System 1: a failing command is a salient, urgent failure; a passing one a salient confirmation.
const scripted: S1Evaluate = async (s1State) => {
  const failed = (s1State as { observation: { facts?: { exitCode?: number } } }).observation.facts?.exitCode !== 0;
  return { inputTokens: 10, costUsd: 0.0001, answers: {
    salient: { type: 'boolean', probability: 0.9 },
    kind: { type: 'choice', choice: failed ? 'failure' : 'confirmation' },
    urgency: { type: 'score', score: failed ? 3 : 1 },
  } };
};

async function fixture(t: TestContext, perception: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ros-perception-'));
  await writeFile(join(root, 'value.ts'), 'export const value = 1;\n');
  // The check passes only once the value is 2, and counts its own runs.
  const check = `echo run >> runs.txt; grep -q "value = 2" value.ts && echo "1 passed" || { echo "1 failed: value is not 2"; exit 1; }`;
  const board = state(root);
  const controller = new Controller(new Workspace(root, check), board, async () => { throw new Error('legacy classifier must not run'); },
    undefined, 0.85, { enabled: false, monitors: { perception }, ...extra }, undefined, scripted);
  t.after(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });
  return { controller, board, root };
}

const tests = { name: 'tests', command: '$CHECK', on: 'edit', debounceMs: 20, serveRunChecks: true };

test('a tests sensor observes each edit; System 1 escalates a failure and serves run_checks for the same revision', async t => {
  const { controller, board, root } = await fixture(t, { commands: [tests] }, { deliverWaitMs: 5000 });
  await controller.tool('read_file', { path: 'value.ts' });
  const broken = await controller.tool('replace_text', { path: 'value.ts', oldText: '1', newText: '3' }) as { system1: Array<{ severity: string; summary: string }> };
  assert.equal(broken.system1[0]!.severity, 'error');
  assert.match(broken.system1[0]!.summary, /tests: failure/);
  const fixed = await controller.tool('replace_text', { path: 'value.ts', oldText: '3', newText: '2' }) as { system1: Array<{ severity: string }> };
  assert.equal(fixed.system1[0]!.severity, 'info');
  const check = await controller.tool('run_checks', {}) as { result: { exitCode: number; observedBy: string } };
  assert.equal(check.result.exitCode, 0);
  assert.match(check.result.observedBy, /tests sensor at edit revision 2/);
  const { readFile } = await import('node:fs/promises');
  // Two sensor runs, zero extra runs for the executive's check.
  assert.equal((await readFile(join(root, 'runs.txt'), 'utf8')).trim().split('\n').length, 2);
  assert.ok(board.frames >= 2);
});

test('ablations: deliver-all reports every novel observation without System 1; deliver-none reports nothing', async t => {
  const all = await fixture(t, { appraiser: 'deliver-all', commands: [tests] }, { deliverWaitMs: 5000 });
  await all.controller.tool('read_file', { path: 'value.ts' });
  const reported = await all.controller.tool('replace_text', { path: 'value.ts', oldText: '1', newText: '3' }) as Record<string, unknown>;
  assert.ok(Array.isArray(reported.system1));
  assert.equal(all.board.frames, 0);

  const none = await fixture(t, { appraiser: 'deliver-none', commands: [tests] }, { deliverWaitMs: 5000 });
  await none.controller.tool('read_file', { path: 'value.ts' });
  const silent = await none.controller.tool('replace_text', { path: 'value.ts', oldText: '1', newText: '3' }) as Record<string, unknown>;
  assert.equal(silent.system1, undefined);
});

test('a burst of edits is debounced into one observation of the latest code', async t => {
  const { controller, root } = await fixture(t, { commands: [{ ...tests, debounceMs: 80 }] });
  await controller.tool('read_file', { path: 'value.ts' });
  await controller.tool('replace_text', { path: 'value.ts', oldText: '1', newText: '3' });
  await controller.tool('replace_text', { path: 'value.ts', oldText: '3', newText: '2' });
  const gate = await controller.finalGate('Done.');
  assert.equal(gate, undefined);
  const { readFile } = await import('node:fs/promises');
  assert.equal((await readFile(join(root, 'runs.txt'), 'utf8')).trim().split('\n').length, 1);
});

test('the final gate raises an unseen failure the executive finished without observing', async t => {
  const { controller } = await fixture(t, { commands: [tests] });
  await controller.tool('read_file', { path: 'value.ts' });
  await controller.tool('replace_text', { path: 'value.ts', oldText: '1', newText: '3' });
  const gate = await controller.finalGate('Fixed it.');
  assert.match(gate!, /tests: failure/);
});

test('a start trigger records a baseline, so appraisal can separate pre-existing problems from new ones', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ros-perception-baseline-'));
  await writeFile(join(root, 'value.ts'), 'export const value = 1;\n');
  const states: Array<{ previousOnStream?: { note: string; editRevision: number } }> = [];
  const capture: S1Evaluate = async (s1State, questions, signal) => { states.push(s1State as typeof states[number]); return scripted(s1State, questions, signal); };
  const controller = new Controller(new Workspace(root, 'echo "1 failed: pre-existing in 0.$RANDOM s"; exit 1'), state(root), async () => { throw new Error('unused'); },
    undefined, 0.85, { enabled: false, monitors: { perception: { commands: [{ ...tests, on: ['start', 'edit'] }] } } }, undefined, capture);
  t.after(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });
  await controller.finalGate('');
  await controller.tool('read_file', { path: 'value.ts' });
  await controller.tool('replace_text', { path: 'value.ts', oldText: '1', newText: '2' });
  await controller.finalGate('Done.');
  // Output identical up to timing after the edit is not novel, so no second evaluation is spent on it.
  assert.equal(states.length, 1);
  assert.equal(states[0]!.previousOnStream, undefined);
});

test('novelty ignores durations, addresses and temp paths but not real changes', async () => {
  const { normalizeForNovelty } = await import('../src/perception.js');
  assert.equal(normalizeForNovelty('60 passed in 3.21s at 0x7f3a /tmp/pytest-of-u/pytest-12/x'), normalizeForNovelty('60 passed in 4.02s at 0x9abc /tmp/pytest-of-u/pytest-13/y'));
  assert.notEqual(normalizeForNovelty('60 passed in 3.21s'), normalizeForNovelty('59 passed, 1 failed in 3.21s'));
});

test('the perception tool returns queued monitor findings', async t => {
  const { controller } = await fixture(t, { commands: [tests] });
  await controller.tool('read_file', { path: 'value.ts' });
  await controller.tool('replace_text', { path: 'value.ts', oldText: '1', newText: '3' });
  await new Promise(resolve => setTimeout(resolve, 300));
  const board = await controller.tool('perception', {}) as { findings: Array<{ summary: string }>; editRevision: number };
  assert.equal(board.editRevision, 1);
  assert.match(board.findings[0]!.summary, /tests: failure/);
});

test('grounded alarms attach the source a failure points to, chosen by System 1, and authorize editing it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ros-perception-ground-'));
  await writeFile(join(root, 'lib.py'), Array.from({ length: 40 }, (_, index) => index === 19 ? 'def broken(): return 1 / 0' : `x${index} = ${index}`).join('\n'));
  await writeFile(join(root, 'test_lib.py'), 'from lib import broken\n');
  const check = `echo 'Traceback (most recent call last):'; echo '  File "${root}/lib.py", line 20, in broken'; echo 'ZeroDivisionError'; exit 1`;
  const grounded: S1Evaluate = async (s1State, questions, signal) => questions.l0
    ? { inputTokens: 5, costUsd: 0.0001, answers: Object.fromEntries(Object.keys(questions).map(key => [key, { type: 'boolean', probability: 0.9 }])) }
    : scripted(s1State, questions, signal);
  const controller = new Controller(new Workspace(root, check), state(root), async () => { throw new Error('unused'); },
    undefined, 0.85, { enabled: false, deliverWaitMs: 5000, monitors: { perception: { commands: [tests], grounding: {} } } }, undefined, grounded);
  t.after(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });
  await controller.tool('read_file', { path: 'test_lib.py' });
  const edit = await controller.tool('replace_text', { path: 'test_lib.py', oldText: 'from', newText: 'from ' }) as { system1: Array<{ evidence: string }> };
  assert.match(edit.system1[0]!.evidence, /lib\.py lines 8-32 \(referenced at line 20; System 1 P\(look here\)=0\.90\)/);
  assert.match(edit.system1[0]!.evidence, /def broken\(\): return 1 \/ 0/);
  const fix = await controller.tool('replace_text', { path: 'lib.py', oldText: '1 / 0', newText: '1' }) as { result: { written: boolean } };
  assert.equal(fix.result.written, true);
});
