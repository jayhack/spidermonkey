// Normalizes user records from the identity provider.
export function normalizeUser(raw) {
  const name = raw.name.trim().replace(/\s+/g, ' ');
  const [firstName, ...rest] = name.split(' ');
  return {
    id: String(raw.id),
    firstName,
    lastName: rest.join(' '),
    email: raw.email.trim().toLowerCase(),
  };
}
