import assert from 'node:assert/strict';
import test from 'node:test';
import { search } from '../src/search.js';

const catalog = [{ id: 1, title: 'Red Lamp' }, { id: 2, title: 'Blue lamp shade' }, { id: 3, title: 'Desk' }, { id: 4, title: 'Lamp post' }];

test('limit caps results in catalog order; default is unlimited', () => {
  assert.deepEqual(search(catalog, 'lamp'), [1, 2, 4]);
  assert.deepEqual(search(catalog, 'lamp', { limit: 2 }), [1, 2]);
  assert.deepEqual(search(catalog, 'lamp', { limit: 0 }), []);
});

test('a negative limit throws RangeError', () => {
  assert.throws(() => search(catalog, 'lamp', { limit: -1 }), RangeError);
});
