import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDuration } from '../src/duration.js';

test('parses single units', () => {
  assert.equal(parseDuration('250ms'), 250);
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1d'), 86_400_000);
});

test('parses compound durations', () => {
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('1m 30s'), 90_000);
});
