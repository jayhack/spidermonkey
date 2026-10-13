import assert from 'node:assert/strict';
import test from 'node:test';
import { formatQuantity } from '../src/format.js';

test('locale-aware formatting with two decimals', () => {
  assert.equal(formatQuantity(1234.5, 'de-DE'), '1.234,50');
  assert.equal(formatQuantity(1234.5, 'en-US'), '1,234.50');
  assert.equal(formatQuantity(3), '3.00');
});
