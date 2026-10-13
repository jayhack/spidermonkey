// Normalizes user records from the identity provider.
export function normalizeUser(raw) {
  const name = raw.name.trim().replace(/\s+/g, ' ');
  const space = name.indexOf(' ');
  return {
    id: String(raw.id),
    firstName: space === -1 ? name : name.slice(0, space),
    lastName: space === -1 ? '' : name.slice(space + 1),
    email: raw.email.trim().toLowerCase(),
  };
}
