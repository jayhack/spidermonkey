import assert from 'node:assert/strict';
import test from 'node:test';
import { tokenize } from '../src/tokenize.js';

test('splits on whitespace', () => {
  assert.deepEqual(tokenize('  alpha beta\tgamma\n'), ['alpha', 'beta', 'gamma']);
});
