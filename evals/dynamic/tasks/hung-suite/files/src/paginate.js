// Collects every item from a cursor-paginated API.
export async function collectAll(fetchPage) {
  const items = [];
  let cursor = null;
  do {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.next;
  } while (cursor !== null);
  return items;
}
