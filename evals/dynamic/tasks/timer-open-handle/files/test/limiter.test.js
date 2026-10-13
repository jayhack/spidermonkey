import assert from 'node:assert/strict';
import test from 'node:test';
import { RateLimiter } from '../src/limiter.js';

function clock(start = 0) {
  let time = start;
  return { now: () => time, advance: ms => { time += ms; } };
}

test('removes tokens until the bucket is empty', () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: time.now });
  assert.equal(limiter.tryRemove(2), true);
  assert.equal(limiter.tryRemove(2), false);
  assert.equal(limiter.available, 1);
});

test('refills over time up to capacity', () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 4, refillPerSecond: 2, now: time.now });
  limiter.tryRemove(4);
  time.advance(1000);
  assert.equal(limiter.available, 2);
  time.advance(10_000);
  assert.equal(limiter.available, 4);
});

test('refill listeners are called on every interval with the available count', async () => {
  const limiter = new RateLimiter({ capacity: 10, refillPerSecond: 100, intervalMs: 50 });
  limiter.tryRemove(10);
  const seen = [];
  limiter.onRefill(available => seen.push(available));
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.ok(seen.length >= 3, `listener ran ${seen.length} times`);
  assert.ok(seen.at(-1) > seen[0], `available should grow: ${seen.join(', ')}`);
});
