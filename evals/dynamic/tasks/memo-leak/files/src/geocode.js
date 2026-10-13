// Resolves a street address to coordinates and a grid cell. Deliberately expensive:
// it stands in for a slow lookup. The result for an address never changes.
export function geocode(address) {
  let hash = 2166136261;
  for (let round = 0; round < 120; round++) {
    for (let index = 0; index < address.length; index++) {
      hash ^= address.charCodeAt(index) + round;
      hash = Math.imul(hash, 16777619) >>> 0;
    }
  }
  return {
    address,
    lat: Number((((hash % 18000) / 100) - 90).toFixed(2)),
    lng: Number(((((hash >>> 8) % 36000) / 100) - 180).toFixed(2)),
    cell: `c${(hash >>> 4) % 4096}`,
  };
}
