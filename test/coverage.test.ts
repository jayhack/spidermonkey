import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Controller } from '../src/controller.js';
import type { DashboardState } from '../src/types.js';
import { Workspace } from '../src/workspace.js';

function state(root: string): DashboardState {
  return { mode: 'test', task: 'Values added at runtime are ignored', workspace: root, status: 'Working', executiveModel: 'test', system1Model: 'test', hz: 2,
    frames: 0, skipped: 0, reflexes: 0, escalations: 0, inputTokens: 0, lastLatencyMs: 0, probabilities: {}, events: [], answer: '' };
}

async function fixture(t: TestContext, coverage: Record<string, unknown>, covered: number) {
  const root = await mkdtemp(join(tmpdir(), 'ros-coverage-'));
  await writeFile(join(root, 'value.ts'), 'export const value = 1;\n');
  const seen: unknown[] = [];
  const controller = new Controller(new Workspace(root, 'echo "12 passed"'), state(root), async () => { throw new Error('unused'); }, undefined, 0.85,
    { enabled: false, monitors: { coverage } }, undefined,
    async s1State => { seen.push(s1State); return { answers: { covered: { type: 'boolean', probability: covered } }, inputTokens: 9, costUsd: 0.0001 }; });
  t.after(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });
  await controller.tool('read_file', { path: 'value.ts' });
  await controller.tool('replace_text', { path: 'value.ts', oldText: '1', newText: '2' });
  return { controller, seen };
}

test('the coverage gate challenges an answer whose evidence does not exercise the reported behavior, once', async t => {
  const { controller, seen } = await fixture(t, { mode: 'system1' }, 0.2);
  const prompt = await controller.finalGate('Fixed; all tests pass.');
  assert.match(prompt!, /P\(covered\)=0\.20/);
  assert.match(prompt!, /Demonstrate the reported scenario/);
  // The gate ran the check itself because the executive never observed the edited code.
  assert.equal((seen[0] as { latestCheck: { exitCode: number } }).latestCheck.exitCode, 0);
  assert.equal(await controller.finalGate('Fixed again.'), undefined);
});

test('covered evidence passes the gate; always and never are the ablations', async t => {
  assert.equal(await (await fixture(t, { mode: 'system1' }, 0.9)).controller.finalGate('Done.'), undefined);
  const always = await fixture(t, { mode: 'always' }, 0.9);
  assert.match((await always.controller.finalGate('Done.'))!, /Demonstrate the reported scenario/);
  assert.equal(always.seen.length, 0);
  assert.equal(await (await fixture(t, { mode: 'never' }, 0.1)).controller.finalGate('Done.'), undefined);
});
