// Searches an in-memory catalog by case-insensitive substring.
export function search(catalog, query, { limit = Infinity } = {}) {
  if (!(limit >= 0)) throw new RangeError(`invalid limit ${limit}`);
  const needle = query.trim().toLowerCase();
  return catalog.filter(item => item.title.toLowerCase().includes(needle)).map(item => item.id).slice(0, limit);
}
