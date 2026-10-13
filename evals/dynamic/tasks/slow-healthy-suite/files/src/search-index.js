import { tokenize } from './tokenize.js';

// Inverted index: token -> set of document ids.
export function buildIndex(documents) {
  const index = new Map();
  for (const [id, text] of documents) {
    for (const token of tokenize(text)) {
      if (!index.has(token)) index.set(token, new Set());
      index.get(token).add(id);
    }
  }
  return index;
}

export function search(index, query) {
  const [first, ...rest] = tokenize(query).map(token => index.get(token) ?? new Set());
  if (!first) return [];
  return [...first].filter(id => rest.every(ids => ids.has(id))).sort();
}
