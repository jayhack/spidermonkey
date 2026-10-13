import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIndex, search } from '../src/search-index.js';
import { tokenize } from '../src/tokenize.js';

test('finds documents containing every query token', () => {
  const index = buildIndex([['a', 'red fish'], ['b', 'blue fish'], ['c', 'red car']]);
  assert.deepEqual(search(index, 'fish'), ['a', 'b']);
  assert.deepEqual(search(index, 'red fish'), ['a']);
});

// Time-boxed soak test: random inputs for a fixed 15 seconds. It prints once at the start
// and then stays silent while it works.
test('soak: tokenize and buildIndex hold their invariants on random text (time-boxed, 15 s)', () => {
  console.log('# soak: fuzzing tokenize/buildIndex for 15 s (time-boxed; prints nothing until done)');
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz ABCDEFG .,;:!?\'-\t\n0123456789';
  const deadline = Date.now() + 15_000;
  let rounds = 0;
  while (Date.now() < deadline) {
    const text = Array.from({ length: 200 }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
    const tokens = tokenize(text);
    for (const token of tokens) assert.ok(token.length > 0 && !/\s/.test(token), `bad token ${JSON.stringify(token)}`);
    const index = buildIndex([[String(rounds), text]]);
    for (const token of tokens) assert.ok(index.get(token)?.has(String(rounds)));
    rounds += 1;
  }
  assert.ok(rounds > 100);
});
