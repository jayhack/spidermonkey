import assert from 'node:assert/strict';
import test from 'node:test';
import { mean, sum } from '../src/stats.js';

test('sum and mean', () => {
  assert.equal(sum([1, 2, 3]), 6);
  assert.equal(mean([2, 4, 9]), 5);
  assert.throws(() => mean([]), RangeError);
});
