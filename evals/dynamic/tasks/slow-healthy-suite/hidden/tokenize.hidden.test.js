import assert from 'node:assert/strict';
import test from 'node:test';
import { tokenize } from '../src/tokenize.js';

test('lowercases and strips surrounding punctuation', () => {
  assert.deepEqual(tokenize('Hello, World!'), ['hello', 'world']);
  assert.deepEqual(tokenize('"Quoted" (words) end.'), ['quoted', 'words', 'end']);
});

test('keeps inner apostrophes and hyphens', () => {
  assert.deepEqual(tokenize("Don't stop: state-of-the-art, ok?"), ["don't", 'stop', 'state-of-the-art', 'ok']);
});

test('drops tokens that are only punctuation', () => {
  assert.deepEqual(tokenize('a -- b ... c !!'), ['a', 'b', 'c']);
});
