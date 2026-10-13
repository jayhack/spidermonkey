import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUser } from '../src/user.js';

test('splits the trimmed name at the first space', () => {
  assert.deepEqual(normalizeUser({ id: 7, name: '  Ada   Lovelace ', email: ' ADA@Example.com ' }),
    { id: '7', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' });
  const grace = normalizeUser({ id: 2, name: 'Grace  Brewster Hopper', email: 'g@example.com' });
  assert.equal(grace.firstName, 'Grace');
  assert.equal(grace.lastName, 'Brewster Hopper');
  assert.equal('name' in grace, false);
});

test('single-word names have an empty lastName', () => {
  const plato = normalizeUser({ id: 3, name: 'Plato', email: 'plato@example.com' });
  assert.equal(plato.firstName, 'Plato');
  assert.equal(plato.lastName, '');
});
