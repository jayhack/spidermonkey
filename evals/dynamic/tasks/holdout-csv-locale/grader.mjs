import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finish, hiddenTests, record, run, taskPath, visibleSuite, workspace } from '../../shared/grade-lib.mjs';

await hiddenTests(taskPath(import.meta.url, 'hidden'));
await visibleSuite();
// The exporter must still produce an importable CSV with the right quantities.
const exported = await run(process.execPath, ['worker/export.js', '--once'], { timeoutMs: 10_000 });
record('report exporter verifies its CSV', exported.code === 0 && !exported.timedOut, exported.output.slice(-400));
let rows = [];
try { rows = readFileSync(join(workspace, 'data/report.csv'), 'utf8').trim().split('\n').slice(1).map(line => line.split(',')); } catch {}
const quantity = text => Number(String(text).replaceAll('"', '').replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
const expected = [1234.5, 7.25, 980, 15.75];
record('CSV quantities are correct', rows.length === 4 && rows.every((row, index) => row.length === 3 && Math.abs(quantity(row[2]) - expected[index]) < 0.001), JSON.stringify(rows));
finish();
