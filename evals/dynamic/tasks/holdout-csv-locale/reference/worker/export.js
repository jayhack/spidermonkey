// Report exporter: writes data/report.csv every 2 s for the Berlin and Boston warehouses,
// then re-reads it the way the downstream importer does to verify it.
//   node worker/export.js          run forever
//   node worker/export.js --once   export once and exit (non-zero if verification fails)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { formatQuantity } from '../src/format.js';

const log = (level, message) => console.log(`${new Date().toISOString()} ${level} export: ${message}`);
const rows = [
  { warehouse: 'berlin', locale: 'de-DE', sku: 'A-100', quantity: 1234.5 },
  { warehouse: 'berlin', locale: 'de-DE', sku: 'B-220', quantity: 7.25 },
  { warehouse: 'boston', locale: 'en-US', sku: 'A-100', quantity: 980 },
  { warehouse: 'boston', locale: 'en-US', sku: 'C-310', quantity: 15.75 },
];

export function exportOnce() {
  mkdirSync('data', { recursive: true });
  // The CSV is machine-readable: it keeps the importer's plain number format.
  const lines = ['warehouse,sku,quantity', ...rows.map(row => [row.warehouse, row.sku, row.quantity.toFixed(2)].join(','))];
  writeFileSync('data/report.csv', `${lines.join('\n')}\n`);
  // Verify as the importer would: plain comma-separated, three columns per row.
  const problems = readFileSync('data/report.csv', 'utf8').trim().split('\n').slice(1)
    .map((line, index) => ({ line, index, columns: line.split(',').length })).filter(row => row.columns !== 3);
  for (const problem of problems) log('ERROR', `report.csv row ${problem.index + 1} has ${problem.columns} columns, expected 3: ${problem.line}`);
  return problems.length;
}

if (process.argv.includes('--once')) process.exit(exportOnce() ? 1 : 0);
log('INFO', 'exporter started');
setInterval(() => { const problems = exportOnce(); if (!problems) log('INFO', `exported ${rows.length} rows`); }, 2000);
