import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Controller } from '../src/controller.js';
import type { Finding, MonitorContext, ToolEvent } from '../src/monitor.js';
import { monitorFactories } from '../src/monitors/index.js';
import type { DashboardState } from '../src/types.js';
import { Workspace } from '../src/workspace.js';

function state(root: string): DashboardState {
  return { mode: 'test', task: 'Fix value', workspace: root, status: 'Working', executiveModel: 'test', system1Model: 'test', hz: 2,
    frames: 0, skipped: 0, reflexes: 0, escalations: 0, inputTokens: 0, lastLatencyMs: 0, probabilities: {}, events: [], answer: '' };
}

// A scripted monitor: records events, answers run_checks from a cache, and reports edits after a delay.
const seen: ToolEvent[] = [];
let context: MonitorContext | undefined;
monitorFactories['test-monitor'] = (config, ctx) => {
  context = ctx;
  const pending: Finding[] = [];
  let work: Promise<void> = Promise.resolve();
  return {
    name: 'test-monitor',
    intercept: async name => name === 'run_checks' && config.cachedCheck ? { exitCode: 0, output: 'cached pass' } : undefined,
    transform: async event => event.name === 'search' ? { ...(event.output as object), annotated: true } : undefined,
    afterTool: event => {
      seen.push(event);
      if (!event.edited.length) return;
      work = new Promise(resolve => setTimeout(() => {
        pending.push({ monitor: 'test-monitor', key: `edit:${event.editRevision}`, severity: 'error', summary: `edit ${event.editRevision} broke a check`, editRevision: event.editRevision });
        resolve();
      }, 30));
    },
    settle: () => work,
    drain: () => pending.splice(0),
  };
};

async function fixture(t: TestContext, tuning: Record<string, unknown>) {
  seen.length = 0;
  const root = await mkdtemp(join(tmpdir(), 'ros-monitor-'));
  await writeFile(join(root, 'value.ts'), 'export const value = 1;\n');
  const board = state(root);
  const controller = new Controller(new Workspace(root, 'exit 3'), board, async () => { throw new Error('legacy classifier must not run'); },
    undefined, 0.85, { enabled: false, ...tuning }, undefined,
    async () => ({ answers: { flag: { type: 'boolean', probability: 0.9 } }, inputTokens: 11, costUsd: 0.0001 }));
  t.after(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });
  return { controller, board };
}

test('monitors can answer a tool call, rewrite results, and observe edits with an edit revision', async t => {
  const { controller } = await fixture(t, { monitors: { 'test-monitor': { cachedCheck: true } } });
  const check = await controller.tool('run_checks', {}) as { result: { output: string } };
  assert.equal(check.result.output, 'cached pass');
  assert.equal(controller.board().lastCheck?.output, 'cached pass');
  const search = await controller.tool('search', { query: 'value' }) as { result: { annotated: boolean } };
  assert.equal(search.result.annotated, true);
  await controller.tool('read_file', { path: 'value.ts' });
  await controller.tool('replace_text', { path: 'value.ts', oldText: '1', newText: '2' });
  assert.deepEqual(seen.map(event => [event.name, event.editRevision, event.edited]),
    [['run_checks', 0, []], ['search', 0, []], ['read_file', 0, []], ['replace_text', 1, ['value.ts']]]);
});

test('findings arrive once on a later tool result, or on the same one when delivery waits', async t => {
  const lazy = await fixture(t, { monitors: { 'test-monitor': {} } });
  await lazy.controller.tool('read_file', { path: 'value.ts' });
  const edit = await lazy.controller.tool('replace_text', { path: 'value.ts', oldText: '1', newText: '2' }) as Record<string, unknown>;
  assert.equal(edit.system1, undefined);
  await new Promise(resolve => setTimeout(resolve, 60));
  const next = await lazy.controller.tool('list_files', {}) as { system1: Array<{ summary: string; severity: string }> };
  assert.equal(next.system1[0]!.summary, 'edit 1 broke a check');
  const again = await lazy.controller.tool('list_files', {}) as Record<string, unknown>;
  assert.equal(again.system1, undefined);

  const eager = await fixture(t, { monitors: { 'test-monitor': {} }, deliverWaitMs: 1000 });
  await eager.controller.tool('read_file', { path: 'value.ts' });
  const waited = await eager.controller.tool('replace_text', { path: 'value.ts', oldText: '1', newText: '2' }) as { system1: unknown[] };
  assert.equal(waited.system1.length, 1);
});

test('the final gate turns undelivered error findings into a follow-up prompt', async t => {
  const { controller } = await fixture(t, { monitors: { 'test-monitor': {} } });
  await controller.tool('read_file', { path: 'value.ts' });
  await controller.tool('replace_text', { path: 'value.ts', oldText: '1', newText: '2' });
  const prompt = await controller.finalGate('Done.');
  assert.match(prompt!, /edit 1 broke a check/);
  assert.equal(await controller.finalGate('Done.'), undefined);
});

test('monitor evaluations are accounted as System 1 frames with reported cost', async t => {
  const { controller, board } = await fixture(t, { monitors: { 'test-monitor': {} } });
  assert.ok(controller);
  const answers = await context!.evaluate('triage', { output: 'x' }, { flag: { type: 'boolean', instructions: 'Is it bad?' } });
  assert.equal(answers.flag!.probability, 0.9);
  assert.equal(board.frames, 1);
  const usage = board.events.find(event => event.lane === 'system1' && event.kind === 'usage')!;
  assert.equal(usage.data?.costUsd, 0.0001);
  assert.equal(usage.data?.purpose, 'triage');
});

test('System 1 routes each executive step to the fast or strong model and records why', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ros-route-'));
  const board = state(root);
  let deliberate = 0.2;
  const controller = new Controller(new Workspace(root), board, async () => { throw new Error('unused'); }, undefined, 0.85,
    { enabled: false, router: { fast: 'fast/model', strong: 'strong/model', mode: 'system1', threshold: 0.5, rate: 0.3 } }, undefined,
    async () => ({ answers: { deliberate: { type: 'boolean', probability: deliberate } }, inputTokens: 7, costUsd: 0.00001 }));
  t.after(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(await controller.route({ step: 1, messages: [] }), { model: 'fast/model' });
  deliberate = 0.8;
  assert.deepEqual(await controller.route({ step: 2, messages: [] }), { model: 'strong/model' });
  const routes = board.events.filter(event => event.kind === 'route');
  assert.deepEqual(routes.map(event => event.data?.strong), [false, true]);
  assert.equal(board.frames, 2);
});
