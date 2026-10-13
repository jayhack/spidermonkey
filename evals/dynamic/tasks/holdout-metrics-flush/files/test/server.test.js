import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from '../src/server.js';

test('serves /health and counts requests', async () => {
  const server = await startServer();
  try {
    assert.equal(await (await fetch(`${server.url}/health`)).text(), 'ok');
    assert.equal((await fetch(`${server.url}/missing`)).status, 404);
    assert.equal(server.metrics.requests, 2);
  } finally { await server.close(); }
});

test('flushes metrics periodically to onFlush', async () => {
  const flushed = [];
  const server = await startServer({ flushIntervalMs: 50, onFlush: snapshot => flushed.push(snapshot) });
  try {
    await fetch(`${server.url}/health`);
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.ok(flushed.length >= 2, `flushed ${flushed.length} times`);
    assert.equal(flushed.at(-1).requests, 1);
  } finally { await server.close(); }
});
