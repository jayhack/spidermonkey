import assert from 'node:assert/strict';
import test from 'node:test';
import { collectAll } from '../src/paginate.js';

const api = pages => async cursor => pages[cursor] ?? { items: [] };

test('collects a single page', async () => {
  assert.deepEqual(await collectAll(api({ null: { items: [1, 2], next: null } })), [1, 2]);
});

test('follows cursors until the last page (the Orders API omits `next` on its last page)', async () => {
  const pages = { null: { items: [1, 2], next: 'b' }, b: { items: [3], next: 'c' }, c: { items: [4] } };
  assert.deepEqual(await collectAll(api(pages)), [1, 2, 3, 4]);
});
