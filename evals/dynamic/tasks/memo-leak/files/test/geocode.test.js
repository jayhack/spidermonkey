import assert from 'node:assert/strict';
import test from 'node:test';
import { geocode } from '../src/geocode.js';

test('geocode is deterministic', () => {
  const first = geocode('100 Market St, Springfield');
  assert.deepEqual(geocode('100 Market St, Springfield'), first);
  assert.ok(first.lat >= -90 && first.lat <= 90);
  assert.ok(first.lng >= -180 && first.lng <= 180);
  assert.match(first.cell, /^c\d+$/);
});
