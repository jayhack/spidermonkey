import assert from 'node:assert/strict';
import test from 'node:test';
import { slugify } from '../src/slug.js';

test('slugifies plain titles', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  Ten   Tips for 2024  '), 'ten-tips-for-2024');
});

test('strips diacritics', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee');
  assert.equal(slugify('Déjà vu'), 'deja-vu');
  assert.equal(slugify('Ünïcödé Café'), 'unicode-cafe');
});
