// Normalizes user records from the identity provider.
export function normalizeUser(raw) {
  return {
    id: String(raw.id),
    name: raw.name.trim().replace(/\s+/g, ' '),
    email: raw.email.trim().toLowerCase(),
  };
}
