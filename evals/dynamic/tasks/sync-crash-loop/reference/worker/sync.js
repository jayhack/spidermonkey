// Directory sync worker: rebuilds data/directory.json from data/users.json.
//   node worker/sync.js          sync every 1.5 s
//   node worker/sync.js --once   sync once, print the entry count, exit
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeUser } from '../src/user.js';

const log = (level, message) => console.log(`${new Date().toISOString()} ${level} sync: ${message}`);

const fullName = user => [user.firstName, user.lastName].filter(Boolean).join(' ');
const initials = user => fullName(user).split(' ').map(part => part[0]).join('').toUpperCase();

export function buildDirectory(rows) {
  return rows.map(normalizeUser).map(user => ({ id: user.id, email: user.email, initials: initials(user), label: `${fullName(user)} <${user.email}>` }));
}

function syncOnce() {
  const directory = buildDirectory(JSON.parse(readFileSync('data/users.json', 'utf8')));
  writeFileSync('data/directory.json', `${JSON.stringify(directory, null, 2)}\n`);
  return directory.length;
}

if (process.argv.includes('--once')) {
  console.log(syncOnce());
} else {
  log('INFO', 'sync worker started');
  setInterval(() => log('INFO', `synced ${syncOnce()} users`), 1500);
}
