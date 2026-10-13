import assert from 'node:assert/strict';
import test from 'node:test';
import { search } from '../src/search.js';

const catalog = [{ id: 1, title: 'Red Lamp' }, { id: 2, title: 'Blue lamp shade' }, { id: 3, title: 'Desk' }];

test('finds titles containing the query, ignoring case', () => {
  assert.deepEqual(search(catalog, 'LAMP'), [1, 2]);
  assert.deepEqual(search(catalog, ' desk '), [3]);
});
