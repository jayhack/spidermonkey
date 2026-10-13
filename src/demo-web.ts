import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubbedEnvironment } from './workspace.js';

// The Spidermonkey web-app demo: an empty workspace, a small web-app task, and a QA bot
// that exercises the app from outside once it is up, the way a teammate clicking around
// would. Valid requests first, then edge cases (malformed JSON, an empty note, a bad id).
// Whatever the executive's server does with them shows up only in its log and in the
// process table: the background world Spidermonkey watches.

export const webPort = 5173;
export const storagePort = 5174;

export const webTask = `Build a small notes web app in this empty workspace, with no external dependencies (Node built-ins only):
- server.js: an HTTP server on port ${webPort} that serves index.html and a JSON API: GET /api/notes, POST /api/notes with {"text": "..."} (reject a missing or empty text with 400), and DELETE /api/notes/:id.
- index.html: a simple page to add, list and delete notes through the API.
- Store notes in the team's storage service, already running at http://127.0.0.1:${storagePort}: GET /kv/notes returns a JSON array, PUT /kv/notes with a JSON array replaces it.
- Tests in test/ using node:test that exercise the API.
Start the server with start_process and leave it running when you are done. A QA bot is already running; it exercises the app on port ${webPort} as soon as the server is up.`;

const qaBot = `
const port = ${webPort};
const log = (line) => process.stdout.write(new Date().toISOString() + ' qa: ' + line + '\\n');
const probe = async (method, path, body, raw) => {
  try {
    const response = await fetch('http://127.0.0.1:' + port + path, { method, headers: { 'content-type': 'application/json' },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(3000) });
    log(method + ' ' + path + ' -> ' + response.status);
    return response.status;
  } catch (error) { return 'down'; }
};
let up = 0;
setInterval(async () => {
  const status = await probe('GET', '/api/notes');
  if (status === 'down') { if (up) log('GET /api/notes -> connection refused (server down?)'); return; }
  up++;
  await probe('POST', '/api/notes', { text: 'buy milk #' + up });
  // After a few healthy rounds, the cases a careful server must survive.
  if (up === 4) await probe('POST', '/api/notes', undefined, '{"text": "unterminated');
  if (up === 5) await probe('POST', '/api/notes', { text: '' });
  if (up === 6) await probe('DELETE', '/api/notes/not-a-number');
  if (up === 7) await probe('POST', '/api/notes', { text: 'emoji ok \\u{1F600} '.repeat(200) });
}, 2500);
`;

// A small key-value service the app must use. Some seconds after the app first writes
// to it, it starts failing the way real dependencies do: errors in its log, then a crash,
// a restart by its supervisor, and another crash. Nothing tells the executive; only the
// storage log, the app's own errors and the process table change.
const storage = `
const http = require('http');
const started = Date.now();
let data = [];
const log = (line) => process.stdout.write(new Date().toISOString() + ' storage: ' + line + '\\n');
// Failures begin a while after the app starts writing, and last across restarts.
const fs = require('fs');
const marker = __dirname + '/first-write';
http.createServer((req, res) => {
  const age = (Date.now() - started) / 1000;
  const since = fs.existsSync(marker) ? (Date.now() - Number(fs.readFileSync(marker, 'utf8'))) / 1000 : -1;
  const failing = since >= Number(process.env.STORAGE_FAIL_AFTER ?? 15);
  if (failing && Math.random() < 0.5) {
    log('ERROR write-ahead log checksum mismatch on segment ' + Math.floor(age) + '; refusing ' + req.method + ' ' + req.url);
    res.writeHead(503).end('storage unavailable');
    if (Math.random() < 0.3) { log('FATAL compaction failed: segment corrupt; exiting'); process.exit(1); }
    return;
  }
  if (req.url !== '/kv/notes') { res.writeHead(404).end(); return; }
  if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data)); return; }
  if (req.method === 'PUT') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { data = JSON.parse(body); if (!fs.existsSync(marker)) fs.writeFileSync(marker, String(Date.now())); log('PUT /kv/notes ' + data.length + ' items'); res.writeHead(204).end(); } catch { res.writeHead(400).end('bad json'); } });
    return;
  }
  res.writeHead(405).end();
}).listen(${storagePort}, () => log('listening on ${storagePort}'));
`;

/** Restart a crashed service after a pause, like a process supervisor. */
const supervisor = `
const { spawn } = require('child_process');
const run = () => { const child = spawn(process.execPath, [process.argv[2]], { stdio: 'inherit' }); child.on('exit', code => { console.log(new Date().toISOString() + ' supervisor: storage exited with code ' + code + '; restarting in 3s'); setTimeout(run, 3000); }); };
run();
`;

/**
 * Stop the background services of an earlier demo run that did not exit cleanly (a closed terminal,
 * a crash). They hold the demo's fixed ports and would answer for the new run. Only this demo's own
 * helper scripts match. Returns how many were stopped.
 */
function stopLeftovers(): number {
  const listing = spawnSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' }).stdout ?? '';
  let stopped = 0;
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s.*\/spidermonkey-web-\w+\/\.qa\/(?:supervisor|qa-bot|storage)\.cjs\b/.exec(line);
    if (!match) continue;
    try { process.kill(Number(match[1]), 'SIGTERM'); stopped++; } catch {}
  }
  return stopped;
}

export async function createWebDemo(options: { storageFailAfterSeconds?: number } = {}) {
  const leftovers = stopLeftovers();
  if (leftovers) await new Promise(done => setTimeout(done, 500));
  // Seconds after the app's first write before storage starts failing.
  const root = await mkdtemp(join(tmpdir(), 'spidermonkey-web-'));
  await mkdir(join(root, 'logs'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'notes-app', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  await mkdir(join(root, '.qa'), { recursive: true });
  await writeFile(join(root, '.qa', 'qa-bot.cjs'), qaBot);
  await writeFile(join(root, '.qa', 'storage.cjs'), storage);
  await writeFile(join(root, '.qa', 'supervisor.cjs'), supervisor);
  const background = async (name: string, args: string[], env: Record<string, string> = {}) => {
    const handle = await open(join(root, 'logs', `${name}.log`), 'a');
    const child: ChildProcess = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ['ignore', handle.fd, handle.fd], env: { ...scrubbedEnvironment(), ...env } });
    await handle.close();
    child.once('error', () => {});
    return child;
  };
  const children = [
    await background('storage', [join(root, '.qa', 'supervisor.cjs'), join(root, '.qa', 'storage.cjs')], { STORAGE_FAIL_AFTER: String(options.storageFailAfterSeconds ?? 8) }),
    await background('qa-bot', [join(root, '.qa', 'qa-bot.cjs')]),
  ];
  return {
    root, task: webTask, leftovers,
    stop: () => { for (const child of children) { try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch {} } },
  };
}
