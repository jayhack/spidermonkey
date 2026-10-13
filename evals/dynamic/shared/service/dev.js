// A minimal nodemon: runs an app, restarts it when watched directories change, and
// restarts it two seconds after a crash.
//   node service/dev.js <dir>... -- <command> [args...]
import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const split = process.argv.indexOf('--');
const watched = process.argv.slice(2, split);
const [command, ...args] = process.argv.slice(split + 1);
const log = message => console.log(`${new Date().toISOString()} [dev] ${message}`);

function snapshot() {
  const entries = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else entries.push(`${path}:${statSync(path).mtimeMs}`);
    }
  };
  for (const directory of watched) { try { walk(directory); } catch {} }
  return entries.sort().join('\n');
}

let child;
let restarting = false;
let crashTimer;
let last = snapshot();

function start() {
  log(`starting \`${[command, ...args].join(' ')}\``);
  child = spawn(command, args, { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    child = undefined;
    if (restarting) return;
    if (code === 0) { log('clean exit - waiting for changes before restart'); return; }
    log(`app crashed (exit ${code ?? signal}) - restarting in 2s`);
    crashTimer = setTimeout(start, 2000);
  });
}

setInterval(() => {
  const now = snapshot();
  if (now === last) return;
  last = now;
  log('restarting due to changes...');
  clearTimeout(crashTimer);
  if (child) {
    restarting = true;
    child.once('exit', () => { restarting = false; start(); });
    child.kill('SIGTERM');
  } else start();
}, 500);

process.on('SIGTERM', () => { child?.kill('SIGKILL'); process.exit(0); });
start();
