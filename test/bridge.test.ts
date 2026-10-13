import assert from 'node:assert/strict';
import test from 'node:test';
import { startBridge } from '../src/bridge.js';
import type { Controller } from '../src/controller.js';

test('bridge authenticates before dispatch and only accepts the tool endpoint', async t => {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const controller = {
    async tool(name: string, input: Record<string, unknown>) {
      calls.push({ name, input });
      return { result: { files: ['index.ts'] }, system1: { findings: [] } };
    },
  } as unknown as Controller;
  const bridge = await startBridge(controller);
  t.after(() => bridge.close());
  const payload = JSON.stringify({ name: 'list_files', input: {} });

  for (const authorization of [undefined, 'Bearer wrong', `Bearer ${'0'.repeat(bridge.token.length)}`]) {
    const response = await fetch(`${bridge.url}/tool`, {
      method: 'POST', headers: authorization ? { authorization } : {}, body: payload,
    });
    assert.equal(response.status, 401);
  }
  const headers = { authorization: `Bearer ${bridge.token}` };
  assert.equal((await fetch(`${bridge.url}/other`, { method: 'POST', headers, body: payload })).status, 404);
  assert.equal((await fetch(`${bridge.url}/tool`, { headers })).status, 404);
  assert.deepEqual(calls, []);

  const response = await fetch(`${bridge.url}/tool`, { method: 'POST', headers, body: payload });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: { files: ['index.ts'] }, system1: { findings: [] } });
  assert.deepEqual(calls, [{ name: 'list_files', input: {} }]);
});

test('bridge rejects invalid JSON and oversized bodies before invoking executive tools', async t => {
  let calls = 0;
  const controller = { async tool() { calls++; return {}; } } as unknown as Controller;
  const bridge = await startBridge(controller);
  t.after(() => bridge.close());
  const headers = { authorization: `Bearer ${bridge.token}` };

  for (const body of ['{broken json', JSON.stringify({ name: 'write_file', input: { content: 'é'.repeat(64_001) } })]) {
    const response = await fetch(`${bridge.url}/tool`, { method: 'POST', headers, body });
    assert.equal(response.status, 400);
    const result = await response.json() as { error: string };
    assert.equal(typeof result.error, 'string');
  }
  assert.equal(calls, 0);
});
