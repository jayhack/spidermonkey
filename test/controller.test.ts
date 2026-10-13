import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Controller } from '../src/controller.js';
import type { Classifier, Decision, Snapshot } from '../src/system1.js';
import type { DashboardState } from '../src/types.js';
import { Workspace } from '../src/workspace.js';

const wait: Decision = { action: 'wait', probability: 0.98, probabilities: { wait: 0.98 }, inputTokens: 3 };

function state(root: string): DashboardState {
  return {
    mode: 'test', task: 'Investigate a failing check', workspace: root, status: 'running',
    executiveModel: 'test-executive', system1Model: 'test-system1', hz: 5,
    frames: 0, skipped: 0, reflexes: 0, escalations: 0, inputTokens: 0,
    lastLatencyMs: 0, probabilities: {}, events: [], answer: '',
  };
}

async function fixture(t: TestContext, classifier: Classifier, files = 1, checkCommand = 'true') {
  const root = await mkdtemp(join(tmpdir(), 'ros-controller-test-'));
  for (let index = 0; index < files; index++) await writeFile(join(root, `file-${index}.ts`), `export const value = ${index};\n`);
  const dashboard = state(root);
  // These policy tests intentionally change classifier behavior without changing
  // the workspace; the unchanged-state optimization has its own test below.
  const controller = new Controller(new Workspace(root, checkCommand), dashboard, classifier, undefined, 0.85, { skipUnchanged: false });
  t.after(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, controller, dashboard };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('reflex reads require a candidate and confident action and target, and stop at the budget', async t => {
  let mode: 'outside' | 'action-uncertain' | 'target-uncertain' | 'missing-target-confidence' | 'read' = 'outside';
  const snapshots: Snapshot[] = [];
  const classifier: Classifier = async snapshot => {
    snapshots.push(snapshot);
    return {
      action: 'read_related_file',
      target: mode === 'outside' ? '../outside.ts' : snapshot.candidates[0],
      probability: mode === 'action-uncertain' ? 0.5 : 0.98,
      ...(mode === 'missing-target-confidence' ? {} : { targetProbability: mode === 'target-uncertain' ? 0.5 : 0.98 }),
      probabilities: { read_related_file: 0.98 }, inputTokens: 4,
    };
  };
  const { controller, dashboard } = await fixture(t, classifier, 10);
  for (const value of ['outside', 'action-uncertain', 'target-uncertain', 'missing-target-confidence'] as const) {
    mode = value;
    await controller.sample('timer');
    assert.equal(dashboard.reflexes, 0, value);
    assert.deepEqual(controller.board().observations, [], value);
  }
  mode = 'read';
  for (let frame = 0; frame < 10; frame++) await controller.sample('timer');
  assert.equal(dashboard.reflexes, 8);
  assert.equal(controller.board().remainingReflexes, 0);
  assert.deepEqual(snapshots.at(-1)?.candidates, snapshots.at(-2)?.candidates);
  assert.ok(controller.board().observations.every(observation => observation.path.startsWith('file-')));
});

test('classification stays single-flight, rejects an externally stale frame, and returns fresh tool context', async t => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const snapshots: Snapshot[] = [];
  let active = 0;
  let maximumActive = 0;
  const classifier: Classifier = async snapshot => {
    snapshots.push(snapshot);
    maximumActive = Math.max(maximumActive, ++active);
    try {
      if (snapshots.length === 1) {
        entered.resolve();
        await release.promise;
        return { action: 'read_related_file', target: 'file-0.ts', probability: 0.98,
          targetProbability: 0.98, probabilities: { read_related_file: 0.98 }, inputTokens: 3 };
      }
      return wait;
    } finally { active--; }
  };
  const { root, controller, dashboard } = await fixture(t, classifier);
  const initial = controller.sample('startup');
  await entered.promise;
  await Promise.all([controller.sample('timer'), controller.sample('timer')]);
  const tool = controller.tool('read_file', { path: 'file-0.ts' });
  await Promise.resolve();
  assert.equal(snapshots.length, 1);
  assert.equal(dashboard.events.filter(event => event.lane === 'executive').length, 0);
  await writeFile(join(root, 'file-0.ts'), 'an external edit while classification was pending\n');
  release.resolve();
  await initial;
  const output = await tool as { result: { content: string }; system1: ReturnType<Controller['board']> };

  assert.equal(maximumActive, 1);
  assert.equal(dashboard.skipped, 2);
  assert.equal(dashboard.reflexes, 0);
  assert.ok(dashboard.events.some(event => event.kind === 'stale'));
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1]?.recentTool?.name, 'read_file');
  assert.ok((snapshots[1]?.revision ?? 0) > (snapshots[0]?.revision ?? 0));
  assert.equal(output.result.content, 'an external edit while classification was pending\n');
  assert.equal(output.system1.revision, snapshots[1]?.revision);
  assert.deepEqual(output.system1.observations, [], 'do not duplicate a directly returned read on the board');
  assert.equal(controller.board().observations[0]?.content, output.result.content);
});

test('check failures escalate in the tool return, deduplicate, and edits invalidate successful verification', async t => {
  const classifier: Classifier = async snapshot => ({
    action: snapshot.recentTool?.name === 'run_checks' && (snapshot.recentTool.output as { exitCode: number }).exitCode !== 0 ? 'escalate' : 'wait', probability: 0.98,
    probabilities: { escalate: 0.98 }, inputTokens: 2,
  });
  const { root, controller, dashboard } = await fixture(t, classifier, 1,
    'if test "$(cat file-0.ts)" = "verified"; then exit 0; else printf "assertion failed\\n"; exit 1; fi');
  const output = await controller.tool('run_checks', {}) as {
    result: { exitCode: number; output: string }; system1: ReturnType<Controller['board']>;
  };
  assert.equal(output.result.exitCode, 1);
  assert.ok(output.system1.findings.some(finding => finding.includes('run_checks') && finding.includes('assertion failed')));
  assert.equal(dashboard.escalations, 1);

  await controller.sample('timer');
  await controller.sample('timer');
  await controller.tool('run_checks', {});
  assert.equal(dashboard.escalations, 1);
  assert.equal(dashboard.events.filter(event => event.kind === 'escalation').length, 1);

  await controller.tool('read_file', { path: 'file-0.ts' });
  await controller.tool('write_file', { path: 'file-0.ts', content: 'verified' });
  await controller.tool('run_checks', {});
  assert.equal(controller.board().lastCheck?.exitCode, 0);
  const edited = await controller.tool('write_file', { path: 'file-0.ts', content: 'unverified edit' }) as {
    system1: ReturnType<Controller['board']>;
  };
  assert.equal(edited.system1.lastCheck, null, 'a passing check must describe the current source');

  await controller.tool('write_file', { path: 'file-0.ts', content: 'verified' });
  await controller.tool('run_checks', {});
  assert.equal(controller.board().lastCheck?.exitCode, 0);
  await writeFile(join(root, 'file-0.ts'), 'changed by another process');
  await controller.sample('timer');
  assert.equal(controller.board().lastCheck, null, 'external edits invalidate verification too');
});

test('classifier failure leaves an executive notice and preserves tool results', async t => {
  const { controller, dashboard } = await fixture(t, async () => { throw new Error('classifier offline'); });
  const output = await controller.tool('read_file', { path: 'file-0.ts' }) as {
    result: { content: string }; system1: ReturnType<Controller['board']>;
  };
  assert.equal(output.result.content, 'export const value = 0;\n');
  assert.equal(dashboard.reflexes, 0);
  assert.ok(output.system1.findings.some(finding => /unavailable/i.test(finding)));
  assert.ok(dashboard.events.some(event => event.kind === 'error' && event.message === 'classifier offline'));
});

test('streamed replies share one transcript entry without evicting prompt history', async t => {
  const { controller, dashboard } = await fixture(t, async () => wait);
  controller.beginTurn('Explain the code');
  const messageKey = 'turn_0:step_0:message_0';
  for (let index = 0; index < 350; index++) controller.emit('executive', 'message_delta', 'x', { messageKey });
  assert.equal(dashboard.events.length, 2, 'token chunks must not evict tool and prompt history');
  assert.equal(dashboard.events[0]?.kind, 'prompt');
  assert.equal(dashboard.events[1]?.message.length, 350);
  assert.equal(dashboard.events[1]?.data?.streaming, true);
  controller.emit('executive', 'message', 'Authoritative completed reply', { messageKey });
  assert.equal(dashboard.events.length, 2);
  assert.equal(dashboard.events[1]?.message, 'Authoritative completed reply');
  assert.equal(dashboard.events[1]?.data?.streaming, false);
  controller.emit('executive', 'message_delta', 'Next turn', { messageKey: 'turn_1:step_0:message_0' });
  assert.equal(dashboard.events.length, 3, 'different turns must retain separate replies');
  for (let index = 0; index < 350; index++) controller.emit('system1', 'decision', 'wait');
  assert.equal(dashboard.events.filter(event => event.lane === 'system1').length, 100);
  assert.equal(dashboard.events.filter(event => event.lane === 'executive').length, 3, 'idle frames must not erase the conversation');
});

test('streamed reasoning summaries accumulate into one block per step, apart from the reply', async t => {
  const { controller, dashboard } = await fixture(t, async () => wait);
  controller.beginTurn('Build it');
  const messageKey = 'turn_0:step_0:reasoning_0';
  controller.emit('executive', 'reasoning_delta', '**Planning** ', { messageKey });
  controller.emit('executive', 'reasoning_delta', 'the server', { messageKey });
  controller.emit('executive', 'message_delta', 'Starting', { messageKey: 'turn_0:step_0:message_0' });
  const reasoning = dashboard.events.filter(event => event.kind === 'reasoning');
  assert.equal(reasoning.length, 1);
  assert.equal(reasoning[0]?.message, '**Planning** the server');
  assert.equal(reasoning[0]?.data?.streaming, true);
  controller.emit('executive', 'reasoning', '**Planning**\n\nthe server.', { messageKey });
  assert.equal(dashboard.events.filter(event => event.kind === 'reasoning').length, 1);
  assert.equal(reasoning[0]?.data?.streaming, false);
  assert.equal(dashboard.events.filter(event => event.kind === 'message').length, 1);
});

test('a new prompt invalidates pending classifications and preserves verified workspace state', async t => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const snapshots: Snapshot[] = [];
  const { controller, dashboard } = await fixture(t, async snapshot => {
    snapshots.push(snapshot);
    if (snapshot.cause === 'pending') {
      entered.resolve();
      await release.promise;
      return { action: 'read_related_file', target: 'file-0.ts', probability: 0.98,
        targetProbability: 0.98, probabilities: { read_related_file: 0.98 }, inputTokens: 3 };
    }
    return wait;
  });
  await controller.tool('run_checks', {});
  const pending = controller.sample('pending');
  await entered.promise;
  controller.beginTurn('Explain the current implementation');
  release.resolve();
  await pending;
  assert.equal(dashboard.reflexes, 0, 'a previous turn cannot trigger a reflex after the next prompt');
  assert.ok(dashboard.events.some(event => event.kind === 'stale'));
  assert.equal(controller.board().lastCheck?.exitCode, 0, 'a prompt alone does not change the source');
  await controller.sample('timer');
  assert.equal(snapshots.at(-1)?.task, 'Explain the current implementation');
  assert.equal(snapshots.at(-1)?.recentTool, null);
});
