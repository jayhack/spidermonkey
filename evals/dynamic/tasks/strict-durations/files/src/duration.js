// Parses human-friendly durations such as "90s", "5m" or "1h30m" into milliseconds.
const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(text) {
  let total = 0;
  for (const [, amount, unit] of String(text).matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    total += Number(amount) * (UNITS[unit.toLowerCase()] ?? 0);
  }
  return total;
}
