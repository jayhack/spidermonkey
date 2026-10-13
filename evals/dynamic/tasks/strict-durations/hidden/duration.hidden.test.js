import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDuration } from '../src/duration.js';

test('valid durations still parse', () => {
  assert.equal(parseDuration('250ms'), 250);
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('1m 30s'), 90_000);
});

test('unknown units, empty input and trailing garbage throw TypeError', () => {
  for (const input of ['5 parsecs', '', '   ', '10s???', 'soon']) assert.throws(() => parseDuration(input), TypeError, JSON.stringify(input));
});
