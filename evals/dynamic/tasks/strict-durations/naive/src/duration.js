// Parses human-friendly durations such as "90s", "5m" or "1h30m" into milliseconds.
const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(text) {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError(`Invalid duration: ${JSON.stringify(text)}`);
  let total = 0;
  let consumed = '';
  for (const [match, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    const scale = UNITS[unit.toLowerCase()];
    if (scale === undefined) throw new TypeError(`Unknown duration unit: ${unit}`);
    total += Number(amount) * scale;
    consumed += match;
  }
  if (consumed.replace(/\s+/g, '') !== text.replace(/\s+/g, '')) throw new TypeError(`Invalid duration: ${JSON.stringify(text)}`);
  return total;
}
