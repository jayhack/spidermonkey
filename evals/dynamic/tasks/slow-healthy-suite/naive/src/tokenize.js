// Splits text into lowercase search tokens without surrounding punctuation.
export function tokenize(text) {
  return text
    .split(/\s+/)
    .map(token => token.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter(Boolean);
}
