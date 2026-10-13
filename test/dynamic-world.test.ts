import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Controller } from '../src/controller.js';
import type { S1Evaluate } from '../src/monitor.js';
import { briefCommand, lineTemplate } from '../src/monitors/perception.js';
import { deliverAll, rulesAppraiser } from '../src/perception.js';
import { startServices } from '../src/services.js';
import type { DashboardState } from '../src/types.js';
import { Workspace } from '../src/workspace.js';
import { analyze, loadTasks, materialize, type TaskSpec } from '../evals/dynamic/lib.js';

function state(root: string): DashboardState {
  return { mode: 'test', task: 'Fix the parser', workspace: root, status: 'Working', executiveModel: 'test', system1Model: 'test', hz: 2,
    frames: 0, skipped: 0, reflexes: 0, escalations: 0, inputTokens: 0, lastLatencyMs: 0, probabilities: {}, events: [], answer: '' };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Scripted System 1: log lines with "boom" are urgent failures; a blocked call is stuck when told so. */
function scripted(stuck: number): S1Evaluate {
  return async s1State => {
    const observation = (s1State as { observation: { stream: string; content: string } }).observation;
    const failing = /boom/.test(observation.content);
    return { inputTokens: 5, costUsd: 0.00001, answers: {
      salient: { type: 'boolean', probability: failing ? 0.95 : 0.1 },
      kind: { type: 'choice', choice: failing ? 'failure' : 'noise' },
      urgency: { type: 'score', score: failing ? 3 : 0 },
      ...(observation.stream.startsWith('blocking:') ? { stuck: { type: 'boolean', probability: stuck } } : {}),
    } };
  };
}

async function fixture(t: TestContext, check: string, perception: Record<string, unknown>, s1: S1Evaluate) {
  const root = await mkdtemp(join(tmpdir(), 'ros-dynamic-'));
  await mkdir(join(root, 'logs'));
  await writeFile(join(root, 'value.ts'), 'export const value = 1;\n');
  const board = state(root);
  const controller = new Controller(new Workspace(root, check, 20_000), board, async () => { throw new Error('legacy classifier must not run'); },
    undefined, 0.85, { enabled: false, monitors: { perception }, monitorTickMs: 100 }, undefined, s1);
  controller.start();
  t.after(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });
  return { controller, board, root };
}

const watchBlocking = { blocking: { everyMs: 200, patienceSeconds: 0.5 } };

test('System 1 interrupts a hung blocking check: the whole process group stops and the finding explains why', async t => {
  // The check leaves a background child and then hangs; both must die with the interrupt.
  const { controller, board, root } = await fixture(t, 'sleep 60 & echo $! > child.pid; echo started; sleep 60', watchBlocking, scripted(0.9));
  const started = Date.now();
  const response = await controller.tool('run_checks', {}) as { result: { interrupted?: boolean; output: string; note?: string }; system1: Array<{ severity: string; summary: string }> };
  assert.ok(Date.now() - started < 8000, 'interrupted well before the 20 s timeout');
  assert.equal(response.result.interrupted, true);
  assert.match(response.result.output, /started/);
  assert.match(response.result.note!, /Stopped early by System 1/);
  assert.equal(response.system1[0]!.severity, 'error');
  assert.match(response.system1[0]!.summary, /blocking:run_checks: interrupted/);
  assert.ok(board.events.some(event => event.lane === 'system1' && event.kind === 'interrupt'), 'the interrupt is recorded');
  const child = Number(await readFile(join(root, 'child.pid'), 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(alive(child), false, 'background child of the check was killed');
});

test('a check System 1 judges to be working is left alone and its result arrives normally', async t => {
  const { controller } = await fixture(t, 'echo working; sleep 1.5; echo done', watchBlocking, scripted(0.1));
  const response = await controller.tool('run_checks', {}) as { result: { exitCode: number; output: string; interrupted?: boolean }; system1?: unknown[] };
  assert.equal(response.result.exitCode, 0);
  assert.equal(response.result.interrupted, undefined);
  assert.match(response.result.output, /done/);
  assert.equal(response.system1, undefined, 'observations of a finished call are not delivered');
});

test('the rules watchdog interrupts after 8 s of silence; deliver-all never interrupts', async () => {
  const blocked = { stream: 'blocking:run_checks', source: 'blocking', content: '', editRevision: 0, interruptible: true };
  assert.equal((await rulesAppraiser.appraise({ ...blocked, facts: { silentSeconds: 9 } }, { task: '', recent: [] })).interrupt, 1);
  assert.equal((await rulesAppraiser.appraise({ ...blocked, facts: { silentSeconds: 3 } }, { task: '', recent: [] })).interrupt, 0);
  assert.equal((await deliverAll.appraise({ ...blocked, facts: { silentSeconds: 60 } }, { task: '', recent: [] })).interrupt, undefined);
  const log = { stream: 'log:logs/app.log', source: 'logs', editRevision: 0 };
  assert.equal((await rulesAppraiser.appraise({ ...log, content: '2026-01-01T00:00:00Z ERROR db: connection lost' }, { task: '', recent: [] })).kind, 'failure');
  assert.equal((await rulesAppraiser.appraise({ ...log, content: '2026-01-01T00:00:00Z INFO http: GET / 200' }, { task: '', recent: [] })).kind, 'noise');
});

test('the log sensor habituates to known line templates and escalates a new failure at the final gate', async t => {
  const { controller, board, root } = await fixture(t, 'true', { logs: { paths: ['logs/*.log'], everyMs: 100 }, settleMs: 200, minSeverity: 'warn' }, scripted(0));
  const log = join(root, 'logs/app.log');
  for (let index = 0; index < 5; index++) await appendFile(log, `2026-01-01T00:00:0${index}Z INFO http: GET /orders/${100 + index} 200 ${index}ms\n`);
  await new Promise(resolve => setTimeout(resolve, 400));
  const appraisalsAfterFirstBatch = board.events.filter(event => event.kind === 'appraisal').length;
  assert.equal(appraisalsAfterFirstBatch, 1, 'one appraisal for the first batch of templates');
  for (let index = 0; index < 20; index++) await appendFile(log, `2026-01-01T00:01:${10 + index}Z INFO http: GET /orders/${200 + index} 200 ${index}ms\n`);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(board.events.filter(event => event.kind === 'appraisal').length, appraisalsAfterFirstBatch, 'routine lines cost no appraisal');
  await controller.tool('read_file', { path: 'value.ts' });
  await controller.tool('replace_text', { path: 'value.ts', oldText: '1', newText: '2' });
  await appendFile(log, '2026-01-01T00:02:00Z ERROR worker: boom while parsing value\n');
  const gate = await controller.finalGate('Done.');
  assert.match(gate!, /log:logs\/app.log: failure/);
  assert.match(gate!, /boom while parsing value/);
  assert.doesNotMatch(gate!, /GET \/orders/, 'routine lines are summarized, not delivered');
});

test('the final gate re-raises a delivered problem that keeps recurring after the last edit', async t => {
  const { controller, root } = await fixture(t, 'true', { logs: { paths: ['logs/*.log'], everyMs: 100 }, settleMs: 2500, minSeverity: 'warn' }, scripted(0));
  const log = join(root, 'logs/app.log');
  await controller.tool('read_file', { path: 'value.ts' });
  await controller.tool('replace_text', { path: 'value.ts', oldText: '1', newText: '2' });
  await appendFile(log, '2026-01-01T00:00:00Z ERROR worker: boom 1\n');
  await new Promise(resolve => setTimeout(resolve, 400));
  // The executive receives the failure with its next tool result...
  const next = await controller.tool('list_files', {}) as { system1?: Array<{ summary: string }> };
  assert.match(next.system1![0]!.summary, /failure/);
  // ...edits again, but the failure keeps recurring (habituated, so no new appraisal).
  await controller.tool('replace_text', { path: 'value.ts', oldText: '2', newText: '3' });
  const ticker = setInterval(() => { void appendFile(log, `${new Date().toISOString()} ERROR worker: boom 2\n`); }, 200);
  try {
    const gate = await controller.finalGate('Done.');
    assert.match(gate!, /Still observed after your last edit/);
    assert.match(gate!, /ERROR worker: boom/);
  } finally { clearInterval(ticker); }
});

test('a check timeout stops the whole process group and says so', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ros-timeout-'));
  try {
    const result = await new Workspace(root, 'sleep 30 & echo $! > child.pid; wait', 500).check();
    assert.equal(result.timedOut, true);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(alive(Number(await readFile(join(root, 'child.pid'), 'utf8'))), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('background services log to the workspace and stop with their process group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ros-services-'));
  try {
    const events: string[] = [];
    const services = await startServices(root, [{ name: 'ticker', command: 'while true; do echo tick; sleep 0.1; done', log: 'logs/ticker.log' }], event => events.push(event.kind));
    await new Promise(resolve => setTimeout(resolve, 400));
    await services.stop();
    assert.match(await readFile(join(root, 'logs/ticker.log'), 'utf8'), /tick/);
    assert.deepEqual(events, ['started', 'exited']);
    const size = (await stat(join(root, 'logs/ticker.log'))).size;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await stat(join(root, 'logs/ticker.log'))).size, size, 'nothing writes after stop');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the process sensor shows harness-started services and hides the harness runtime', async t => {
  const { board, root } = await fixture(t, 'true', { processes: { everyMs: 100 } }, scripted(0));
  const services = await startServices(root, [
    { name: 'worker', command: 'exec node -e "setInterval(() => {}, 1000)" worker-marker', log: 'logs/worker.log' },
    { name: 'runtime', command: 'exec node -e "setInterval(() => {}, 1000)" eve.js dev', log: 'logs/runtime.log' },
  ]);
  t.after(() => services.stop());
  const deadline = Date.now() + 5000;
  let content = '';
  while (Date.now() < deadline && !content) {
    await new Promise(resolve => setTimeout(resolve, 100));
    content = String((board.events.find(event => event.kind === 'appraisal' && event.data?.stream === 'processes')?.data?.observed as { content?: string } | undefined)?.content ?? '');
  }
  assert.match(content, /worker-marker/);
  assert.doesNotMatch(content, /eve\.js dev/);
});

test('line templates and brief commands keep the shape and drop the noise', () => {
  assert.equal(lineTemplate('2026-09-30T23:17:51.033Z INFO http: GET /api/orders/1042 200 14ms'), lineTemplate('2026-10-01T01:02:03.000Z INFO http: GET /api/orders/7 200 3ms'));
  assert.notEqual(lineTemplate('INFO http: GET / 200'), lineTemplate('ERROR http: GET / 500'));
  assert.equal(briefCommand('/usr/local/bin/node --use-system-ca --test-isolation=process test/paginate.test.js'), 'node test/paginate.test.js');
  assert.equal(briefCommand('/usr/local/bin/node --test'), 'node --test');
});

test('dynamic tasks materialize with services and grade-free metadata; analysis measures blocked time and detection', async () => {
  const tasks = await loadTasks();
  assert.equal(tasks.length, 8);
  for (const task of tasks) {
    assert.ok(task.prompt && task.check && task.hazard, task.id);
    if (task.hazard === 'escalate') assert.ok(task.event && task.relevantStreams.length, task.id);
  }
  const sync = tasks.find(task => task.id === 'sync-crash-loop')!;
  const workspace = await materialize(sync);
  try {
    assert.ok((await stat(join(workspace, 'service/dev.js'))).isFile());
    assert.equal(JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')).type, 'module');
    await assert.rejects(stat(join(workspace, 'hidden')), 'hidden tests never enter the workspace');
  } finally { await rm(workspace, { recursive: true, force: true }); }

  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
  const hazard: TaskSpec = { ...sync, id: 'synthetic' };
  const events = [
    { at: at(0), lane: 'executive', kind: 'prompt', message: 'task' },
    { at: at(1), lane: 'executive', kind: 'tool', message: 'replace_text', data: { toolName: 'replace_text', path: 'src/user.js' } },
    { at: at(2), lane: 'environment', kind: 'result', message: 'ok', data: { toolName: 'replace_text', output: { written: true } } },
    { at: at(6), lane: 'system1', kind: 'escalation', message: 'x', data: { key: 'log:logs/sync.log:abc', severity: 'error', summary: 'log:logs/sync.log: failure' } },
    { at: at(7), lane: 'executive', kind: 'tool', message: 'run_checks', data: { toolName: 'run_checks' } },
    { at: at(19), lane: 'environment', kind: 'result', message: 'x', data: { toolName: 'run_checks', output: { exitCode: 1, interrupted: true } } },
  ] as never;
  const world = { 'logs/sync.log': `${at(0)} INFO sync: synced 5 users\n${at(4)} [dev] app crashed (exit 1) - restarting in 2s\n` };
  const result = analyze(hazard, 'perception', 1, events, world, { mode: 'live', status: 'completed', elapsedSeconds: 20 }, { pass: true, checks: [] });
  assert.equal(result.detectionSeconds, 2);
  assert.equal(result.detectedBy, 'finding:log:logs/sync.log');
  assert.equal(result.blockedSeconds, 12);
  assert.equal(result.relevantDelivered, 1);
});
