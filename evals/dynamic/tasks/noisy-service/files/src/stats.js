// Small numeric helpers used by the API server's latency summaries.
export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

export function mean(values) {
  if (!values.length) throw new RangeError('mean of an empty list');
  return sum(values) / values.length;
}
