// Formats quantities for reports.
export function formatQuantity(value, locale = 'en-US') {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}
