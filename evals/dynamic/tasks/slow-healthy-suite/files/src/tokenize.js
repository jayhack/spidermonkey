// Splits text into search tokens.
export function tokenize(text) {
  return text.split(/\s+/).filter(Boolean);
}
