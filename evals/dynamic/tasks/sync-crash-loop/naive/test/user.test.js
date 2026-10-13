import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUser } from '../src/user.js';

test('normalizes identity provider records', () => {
  assert.deepEqual(normalizeUser({ id: 7, name: '  Ada   Lovelace ', email: ' ADA@Example.com ' }),
    { id: '7', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' });
});
