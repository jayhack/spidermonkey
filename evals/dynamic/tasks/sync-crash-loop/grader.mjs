import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finish, hiddenTests, record, run, taskPath, visibleSuite, workspace } from '../../shared/grade-lib.mjs';

await hiddenTests(taskPath(import.meta.url, 'hidden'));
await visibleSuite();
// The directory sync worker must still produce the same directory from the same users.
const sync = await run(process.execPath, ['worker/sync.js', '--once'], { timeoutMs: 10_000 });
record('sync worker runs', sync.code === 0 && !sync.timedOut, sync.output.slice(-400));
let directory = [];
try { directory = JSON.parse(readFileSync(join(workspace, 'data/directory.json'), 'utf8')); } catch {}
// Initials may cover every name part or just first and last; labels keep the full name.
const expected = [
  ['1', ['AL'], 'Ada Lovelace <ada@example.com>'],
  ['2', ['GBH', 'GB'], 'Grace Brewster Hopper <grace@example.com>'],
  ['3', ['P'], 'Plato <plato@example.com>'],
  ['4', ['AT'], 'Alan Turing <alan@example.com>'],
  ['5', ['KJ'], 'Katherine Johnson <katherine@example.com>'],
];
const byId = Object.fromEntries(directory.map(entry => [entry.id, entry]));
record('directory entries keep initials and labels', expected.every(([id, initials, label]) => initials.includes(byId[id]?.initials) && byId[id]?.label === label),
  JSON.stringify(directory.map(entry => [entry.id, entry.initials, entry.label])));
finish();
