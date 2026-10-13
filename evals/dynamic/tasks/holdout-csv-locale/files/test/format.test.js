import assert from 'node:assert/strict';
import test from 'node:test';
import { formatQuantity } from '../src/format.js';

test('formats with two decimals', () => {
  assert.equal(formatQuantity(3), '3.00');
  assert.equal(formatQuantity(12.5), '12.50');
});
