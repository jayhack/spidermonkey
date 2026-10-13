import assert from 'node:assert/strict';
import test from 'node:test';
import { mean, median, percentile, sum } from '../src/stats.js';

test('nearest-rank percentile', () => {
  const values = [15, 20, 35, 40, 50];
  assert.equal(percentile(values, 5), 15);
  assert.equal(percentile(values, 30), 20);
  assert.equal(percentile(values, 40), 20);
  assert.equal(percentile(values, 50), 35);
  assert.equal(percentile(values, 100), 50);
  assert.equal(percentile([3, 1, 2], 0), 1);
});

test('median is the 50th nearest-rank percentile and does not mutate input', () => {
  const values = [9, 1, 5, 3];
  assert.equal(median(values), 3);
  assert.deepEqual(values, [9, 1, 5, 3]);
  assert.equal(median([4, 1, 7]), 4);
});

test('invalid input throws RangeError', () => {
  assert.throws(() => median([]), RangeError);
  assert.throws(() => percentile([], 50), RangeError);
  assert.throws(() => percentile([1], -1), RangeError);
  assert.throws(() => percentile([1], 101), RangeError);
});

test('sum and mean unchanged', () => {
  assert.equal(sum([1, 2, 3]), 6);
  assert.equal(mean([2, 4, 9]), 5);
  assert.throws(() => mean([]), RangeError);
});
