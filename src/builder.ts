import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { scrubbedEnvironment } from './workspace.js';

// Builder tools for the web-app demo agent: a bounded foreground command and named
// background processes (dev servers, workers). Everything runs in the workspace with
// credentials scrubbed from the environment, in its own process group so it can be
// stopped as a whole. Background output goes to logs/<name>.log, where both the
// executive (read_file) and Spidermonkey can see it.

export interface CommandResult { exitCode: number; output: string; timedOut: boolean; durationMs: number }

export interface RunOptions { signal?: AbortSignal; onOutput?: (text: string) => void; onSpawn?: (pid: number | undefined) => void }

export function runShell(root: string, command: string, timeoutMs: number, options: RunOptions = {}): Promise<CommandResult & { interrupted: boolean }> {
  const started = performance.now();
  return new Promise(done => {
    const child = spawn('/bin/sh', ['-c', command], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: scrubbedEnvironment() });
    options.onSpawn?.(child.pid);
    let output = '';
    let stopping: 'timeout' | 'interrupt' | undefined;
    const append = (chunk: Buffer) => { const text = chunk.toString('utf8'); output = (output + text).slice(-200_000); options.onOutput?.(text); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const group = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch {} };
    // The whole process group stops: a test runner cannot outlive the call.
    const stop = (reason: 'timeout' | 'interrupt') => { if (stopping) return; stopping = reason; group('SIGTERM'); setTimeout(() => group('SIGKILL'), 2000); };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    options.signal?.addEventListener('abort', () => stop('interrupt'), { once: true });
    child.once('error', error => { output += String(error); });
    child.once('close', code => {
      clearTimeout(timer);
      done({ exitCode: stopping ? 124 : code ?? 1, output: output.slice(-8000), timedOut: stopping === 'timeout', interrupted: stopping === 'interrupt',
        durationMs: Math.round(performance.now() - started) });
    });
  });
}

interface Running { name: string; command: string; log: string; child: ChildProcess; startedAt: number; exit?: { code: number | null; signal: string | null; at: number } }

export class Processes {
  private running = new Map<string, Running>();
  constructor(private root: string) {}

  async start(name: string, command: string) {
    if (!/^[\w.-]{1,40}$/.test(name)) throw new Error('name must be 1-40 letters, digits, dots, dashes or underscores');
    const current = this.running.get(name);
    if (current && !current.exit) throw new Error(`${name} is already running (pid ${current.child.pid}); stop it first`);
    const log = `logs/${name}.log`;
    const path = resolve(this.root, log);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, 'a');
    const child = spawn('/bin/sh', ['-c', command], { cwd: this.root, detached: true, stdio: ['ignore', handle.fd, handle.fd], env: scrubbedEnvironment() });
    await handle.close();
    const entry: Running = { name, command, log, child, startedAt: Date.now() };
    child.once('exit', (code, signal) => { entry.exit = { code, signal, at: Date.now() }; });
    child.once('error', () => {});
    this.running.set(name, entry);
    // A moment for an immediate crash (bad syntax, port in use) to show in the result.
    await new Promise(done => setTimeout(done, 800));
    return this.describe(entry);
  }

  async stop(name: string) {
    const entry = this.running.get(name);
    if (!entry) throw new Error(`No process named ${name}`);
    if (!entry.exit) {
      const group = (signal: NodeJS.Signals) => { try { if (entry.child.pid) process.kill(-entry.child.pid, signal); } catch {} };
      group('SIGTERM');
      await Promise.race([new Promise(done => entry.child.once('exit', done)), new Promise(done => setTimeout(done, 2000))]);
      if (!entry.exit) group('SIGKILL');
    }
    this.running.delete(name);
    return { name, stopped: true };
  }

  list() { return [...this.running.values()].map(entry => this.describe(entry)); }

  private describe(entry: Running) {
    return { name: entry.name, command: entry.command, pid: entry.child.pid, log: entry.log,
      running: !entry.exit, ...(entry.exit ? { exitCode: entry.exit.code, signal: entry.exit.signal } : {}) };
  }

  async stopAll() { await Promise.all([...this.running.keys()].map(name => this.stop(name).catch(() => {}))); }
}
