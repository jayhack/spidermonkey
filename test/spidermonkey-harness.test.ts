import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Controller } from '../src/controller.js';
import type { DashboardState } from '../src/types.js';
import { Workspace } from '../src/workspace.js';

function state(root: string): DashboardState {
  return { mode: 'test', task: 'Build a notes app', workspace: root, status: 'Working', executiveModel: 'test', system1Model: 'test', hz: 2,
    frames: 0, skipped: 0, reflexes: 0, escalations: 0, inputTokens: 0, lastLatencyMs: 0, probabilities: {}, events: [], answer: '' };
}

test('the builder agent creates files, starts processes Spidermonkey watches, and receives its findings on the next tool result', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ros-sm-harness-'));
  const board = state(root);
  // appraiser "all": every novel event is reported, so the test needs no model.
  const controller = new Controller(new Workspace(root, 'node --test', 30_000, { extensions: ['.html'], allowCreate: true }), board,
    async () => { throw new Error('unused'); }, undefined, 0.85,
    { enabled: true, continuous: false, builder: true, monitors: { spidermonkey: { intervalMs: 300, appraiser: 'all' } } });
  t.after(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });
  controller.beginTurn(board.task);
  controller.start();

  const created = await controller.tool('write_file', { path: 'web/index.html', content: '<h1>notes</h1>\n' }) as { result: { created: boolean } };
  assert.equal(created.result.created, true);
  const again = await controller.tool('write_file', { path: 'web/index.html', content: '<h1>notes!</h1>\n' }) as { result: { written?: boolean } };
  assert.equal(again.result.written, true, 'a file the agent created is known content');
  await writeFile(join(root, 'README.md'), 'someone else wrote this\n');
  const unread = await controller.tool('write_file', { path: 'README.md', content: 'x' }) as { result: { error?: string } };
  assert.match(unread.result.error!, /Read the file before editing/);

  const started = await controller.tool('start_process', { name: 'server', command: `node -e "setTimeout(() => console.log('2026-10-01T00:00:00Z ERROR TypeError: total is undefined'), 500); setInterval(() => {}, 1000)"` }) as { result: { running: boolean; log: string } };
  assert.equal(started.result.running, true);
  assert.equal(started.result.log, 'logs/server.log');

  const status = await controller.tool('spidermonkey', { action: 'status' }) as { result: { watching: Array<{ label: string }> } };
  assert.ok(status.result.watching.some(entity => entity.label === 'logs/server.log'), 'the started process log is watched natively');

  let delivered: Array<{ summary: string }> = [];
  for (let attempt = 0; attempt < 20 && !delivered.some(finding => /logs\/server\.log/.test(finding.summary)); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 300));
    const result = await controller.tool('list_files', {}) as { system1?: Array<{ summary: string }> };
    delivered = [...delivered, ...(result.system1 ?? [])];
  }
  assert.ok(delivered.some(finding => /new kind of line in logs\/server\.log/.test(finding.summary)), JSON.stringify(delivered));
  assert.ok(board.events.some(event => event.lane === 'system1' && event.data?.monitor === 'spidermonkey'), 'injections are visible to the dashboard');

  const watch = await controller.tool('spidermonkey', { action: 'watch', command: 'node --test', name: 'tests', everySeconds: 30, priority: 'focus' }) as { result: { watching: { id: string; priority: number } } };
  assert.deepEqual([watch.result.watching.id, watch.result.watching.priority], ['command:tests', 3]);
  const stopped = await controller.tool('stop_process', { name: 'server' }) as { result: { stopped: boolean } };
  assert.equal(stopped.result.stopped, true);
});
