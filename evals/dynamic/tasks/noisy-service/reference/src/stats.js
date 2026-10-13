// Small numeric helpers used by the API server's latency summaries.
export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

export function mean(values) {
  if (!values.length) throw new RangeError('mean of an empty list');
  return sum(values) / values.length;
}

/** Nearest-rank percentile, p in [0, 100]. */
export function percentile(values, p) {
  if (!values.length) throw new RangeError('percentile of an empty list');
  if (typeof p !== 'number' || Number.isNaN(p) || p < 0 || p > 100) throw new RangeError(`percentile out of range: ${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

export function median(values) {
  return percentile(values, 50);
}
