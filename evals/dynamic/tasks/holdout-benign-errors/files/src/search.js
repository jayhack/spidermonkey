// Searches an in-memory catalog by case-insensitive substring.
export function search(catalog, query) {
  const needle = query.trim().toLowerCase();
  return catalog.filter(item => item.title.toLowerCase().includes(needle)).map(item => item.id);
}
