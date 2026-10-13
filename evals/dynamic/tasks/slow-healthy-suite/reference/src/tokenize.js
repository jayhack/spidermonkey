// Splits text into lowercase search tokens without surrounding punctuation.
export function tokenize(text) {
  return text
    .split(/\s+/)
    .map(token => token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
}
