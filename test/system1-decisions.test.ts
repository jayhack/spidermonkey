import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Controller } from '../src/controller.js';
import type { Classifier, Decision } from '../src/system1.js';
import type { DashboardState } from '../src/types.js';
import { Workspace } from '../src/workspace.js';

const read: Decision = { action: 'read_related_file', target: 'source.ts', probability: 0.98,
  targetProbability: 0.98, probabilities: { read_related_file: 0.98, wait: 0.01, escalate: 0.01 }, inputTokens: 3 };
const wait: Decision = { action: 'wait', probability: 0.98, probabilities: { wait: 0.98 }, inputTokens: 3 };

async function fixture(t: TestContext, classifier: Classifier, check = 'true') {
  const root = await mkdtemp(join(tmpdir(), 'ros-decision-test-'));
  await writeFile(join(root, 'source.ts'), 'export const value = 1;\n');
  const state: DashboardState = {
    mode: 'test', workspace: root, task: 'Inspect source', status: 'Working', executiveModel: 'test', system1Model: 'test', hz: 2,
    frames: 0, skipped: 0, reflexes: 0, escalations: 0, inputTokens: 0, lastLatencyMs: 0, probabilities: {}, events: [], answer: '',
  };
  const controller = new Controller(new Workspace(root, check), state, classifier);
  t.after(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });
  return { controller, state };
}

test('decision details distinguish held action, held target, and invalid candidate from an actual read', async t => {
  for (const [decision, reason] of [
    [{ ...read, probability: 0.53 }, /Action confidence/],
    [{ ...read, targetProbability: 0.4 }, /File confidence/],
    [{ ...read, target: '../outside.ts' }, /not an unread candidate/],
  ] as const) {
    const { controller, state } = await fixture(t, async () => decision);
    await controller.sample('startup');
    assert.equal(state.latestDecision?.outcome, 'held');
    assert.equal(state.lastProposal?.target, decision.target);
    assert.equal(state.latestDecision?.threshold, 0.85);
    assert.match(state.latestDecision!.detail, reason);
    assert.equal(state.reflexes, 0);
    assert.deepEqual(controller.board().observations, []);
    assert.equal(state.events.filter(event => event.kind === 'decision').length, 1);
    assert.equal(state.events.filter(event => event.kind === 'uncertain').length, 0, 'the decision includes the gate result without a second warning');
  }
});

test('a completed read reports its real effect and remains visible during subsequent waiting frames', async t => {
  let decision = read;
  const { controller, state } = await fixture(t, async () => decision);
  await controller.tool('list_files', {});
  const applied = state.lastProposal;
  assert.equal(applied?.outcome, 'read');
  assert.match(applied!.observed, /1 files listed/);
  assert.match(applied!.detail, /Read 1 lines into the perception board/);
  assert.equal(controller.board().observations[0]?.content, 'export const value = 1;\n');
  decision = wait;
  await controller.tool('read_file', { path: 'source.ts' });
  assert.equal(state.latestDecision?.outcome, 'waiting');
  assert.equal(state.lastProposal, applied, 'waiting must not overwrite the useful action detail');
  controller.beginTurn('Another task');
  assert.equal(state.lastProposal, undefined, 'old decision details must not appear as part of a new task');
});

test('escalations show the observed failure and distinguish an existing finding from a new one', async t => {
  const { controller, state } = await fixture(t, async () => ({ ...wait, action: 'escalate' }),
    "printf 'assertion failed\\n'; exit 1");
  await controller.tool('run_checks', {});
  assert.equal(state.latestDecision?.outcome, 'escalated');
  assert.equal(state.latestDecision?.tool, 'run_checks');
  assert.match(state.latestDecision!.observed, /run_checks exited 1.*assertion failed/);
  assert.match(state.latestDecision!.detail, /Added a finding to the perception board/);
  await controller.tool('run_checks', {});
  assert.equal(state.latestDecision?.outcome, 'duplicate');
  assert.equal(state.escalations, 1);
});
