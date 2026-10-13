import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

const excluded = new Set(['node_modules', '.git', '.eve', '.vercel', '.ros', '.output', 'dist', 'build', '.ssh', '.aws', '__pycache__', 'venv']);
// Logs and JSONL queues are readable so the executive can inspect background processes itself.
const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonl', '.log', '.md', '.py', '.go', '.rs', '.txt', '.yaml', '.yml']);
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const excludedPath = (name: string) => name.split(/[\\/]/).some(part => excluded.has(part) || part.startsWith('.') || /^(credentials|id_rsa|id_ed25519|.*\.pem)$/.test(part));

export interface WorkspaceOptions {
  /** Extra readable and writable extensions, e.g. web assets for the builder agent. */
  extensions?: string[];
  /** Allow creating new files (the builder agent); SWE-bench tasks only edit existing ones. */
  allowCreate?: boolean;
}

export class Workspace {
  private reads = new Map<string, string>();
  private extensions: Set<string>;
  constructor(readonly root: string, readonly checkCommand: string = 'node --test', readonly checkTimeoutMs = 30_000, readonly options: WorkspaceOptions = {}) {
    this.extensions = new Set([...extensions, ...(options.extensions ?? [])]);
  }

  private async path(name: string): Promise<string> {
    if (isAbsolute(name) || excludedPath(name)) {
      throw new Error('Path is outside the readable workspace surface');
    }
    const target = resolve(this.root, name);
    const canonical = await realpath(target);
    const root = await realpath(this.root);
    if (canonical !== root && !canonical.startsWith(root + sep)) throw new Error('Path escapes workspace');
    if (excludedPath(relative(root, canonical))) throw new Error('Canonical path is excluded from the readable workspace surface');
    if (!this.extensions.has(extname(target)) || !this.extensions.has(extname(canonical))) throw new Error('Only source and text files are supported in v0');
    return canonical;
  }

  async list(query?: string): Promise<string[]> {
    const files: string[] = [];
    const walk = async (directory: string, depth: number) => {
      if (depth > 16 || files.length >= 20_000) return;
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.length >= 20_000) break;
        if (excludedPath(entry.name)) continue;
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) await walk(path, depth + 1);
        else if (entry.isFile() && this.extensions.has(extname(entry.name))) files.push(relative(this.root, path));
      }
    };
    await walk(this.root, 0);
    return query ? files.filter(path => path.toLowerCase().includes(query.toLowerCase())) : files;
  }

  async inventory() {
    const files = await this.list();
    return Promise.all(files.map(async path => {
      const metadata = await stat(resolve(this.root, path));
      return { path, mtimeMs: metadata.mtimeMs, size: metadata.size };
    }));
  }

  /** Confined read that does not authorize a later edit; used for System 1 ranking. */
  async peek(name: string) {
    const path = await this.path(name);
    if ((await lstat(path)).size > 512_000) throw new Error('File exceeds the 512KB read limit');
    return readFile(path, 'utf8');
  }

  async read(name: string) {
    const path = await this.path(name);
    const before = await lstat(path);
    if (before.size > 512_000) throw new Error('File exceeds the 512KB read limit');
    const content = await readFile(path, 'utf8');
    const after = await stat(path);
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('File changed during the read; read it again');
    this.reads.set(name, digest(content));
    return { path: name, content, hash: digest(content), version: `${after.mtimeMs}:${after.size}` };
  }

  async write(name: string, content: string) {
    const path = await this.path(name);
    if (Buffer.byteLength(content) > 512_000) throw new Error('Edit exceeds the 512KB write limit');
    const current = await readFile(path, 'utf8');
    if (!this.reads.has(name)) throw new Error('Read the file before editing it');
    if (digest(current) !== this.reads.get(name)) throw new Error('File changed after the read; read it again before editing');
    await writeFile(path, content, 'utf8');
    const metadata = await stat(path);
    this.reads.set(name, digest(content));
    return { path: name, written: true, hash: digest(content), version: `${metadata.mtimeMs}:${metadata.size}` };
  }

  /** Create a new file (builder agent only). Existing files must be read and edited instead. */
  async create(name: string, content: string) {
    if (!this.options.allowCreate) throw new Error('Creating files is not enabled in this workspace');
    if (isAbsolute(name) || excludedPath(name)) throw new Error('Path is outside the writable workspace surface');
    if (!this.extensions.has(extname(name))) throw new Error(`Unsupported file type ${extname(name) || '(none)'}`);
    if (Buffer.byteLength(content) > 512_000) throw new Error('File exceeds the 512KB write limit');
    const root = await realpath(this.root);
    const target = resolve(root, name);
    if (!target.startsWith(root + sep)) throw new Error('Path escapes workspace');
    await mkdir(dirname(target), { recursive: true });
    const parent = await realpath(dirname(target));
    if (parent !== root && !parent.startsWith(root + sep)) throw new Error('Path escapes workspace');
    try { await lstat(target); throw new Error('File exists; read it, then edit it with write_file or replace_text'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
    const metadata = await stat(target);
    this.reads.set(name, digest(content));
    return { path: name, written: true, created: true, hash: digest(content), version: `${metadata.mtimeMs}:${metadata.size}` };
  }

  async exists(name: string) {
    try { await lstat(resolve(this.root, name)); return true; } catch { return false; }
  }

  async search(query: string) {
    if (!query.trim() || query.length > 200) throw new Error('Search query must be 1–200 characters');
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const name of await this.list()) {
      const path = await this.path(name);
      if ((await stat(path)).size > 512_000) continue;
      const lines = (await readFile(path, 'utf8')).split('\n');
      for (let index = 0; index < lines.length; index++) {
        if (lines[index]!.includes(query)) matches.push({ path: name, line: index + 1, text: lines[index]!.slice(0, 300) });
        if (matches.length >= 40) return { matches, truncated: true };
      }
    }
    return { matches, truncated: false };
  }

  async replace(name: string, oldText: string, newText: string) {
    if (!this.reads.has(name)) throw new Error('Read the file before editing it');
    const path = await this.path(name);
    const before = await readFile(path, 'utf8');
    if (digest(before) !== this.reads.get(name)) throw new Error('File changed after the read; read it again before editing');
    if (!oldText || before.split(oldText).length !== 2) throw new Error('oldText must match exactly once');
    const content = before.replace(oldText, () => newText);
    return { before, content, result: await this.write(name, content) };
  }

  /**
   * Run the check command in its own process group. A timeout or an abort stops the
   * whole group (SIGTERM, then SIGKILL), so a hung test runner cannot outlive the call.
   * `onOutput` and `onSpawn` let perception watch the call while the executive waits.
   */
  async check(options: CheckOptions = {}): Promise<CheckResult> {
    return new Promise<CheckResult>((done) => {
      const started = performance.now();
      const child = spawn('/bin/sh', ['-c', this.checkCommand], {
        cwd: this.root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        // Workspace tests do not need the model connection or tool bridge credentials.
        env: scrubbedEnvironment(),
      });
      let output = '';
      let stopping: 'timeout' | 'interrupt' | undefined;
      let finished = false;
      const append = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        output = (output + text).slice(-512_000);
        options.onOutput?.(text);
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const signalGroup = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch {} };
      let hardKill: ReturnType<typeof setTimeout> | undefined;
      // SIGTERM first: test runners such as `node --test` then report what was still running.
      const stop = (reason: 'timeout' | 'interrupt') => {
        if (stopping || finished) return;
        stopping = reason;
        signalGroup('SIGTERM');
        hardKill = setTimeout(() => signalGroup('SIGKILL'), 2000);
      };
      const timer = setTimeout(() => stop('timeout'), this.checkTimeoutMs);
      const onAbort = () => stop('interrupt');
      if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true });
      const finish = (exitCode: number) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(hardKill);
        options.signal?.removeEventListener('abort', onAbort);
        const result: CheckResult = { exitCode, output: output.slice(-12_000) };
        if (stopping === 'timeout') result.timedOut = true;
        if (stopping === 'interrupt') result.interrupted = true;
        if (stopping) result.durationMs = Math.round(performance.now() - started);
        done(result);
      };
      child.once('error', error => { output += String(error.message); finish(1); });
      child.once('spawn', () => { if (child.pid) options.onSpawn?.(child.pid); });
      child.once('exit', code => {
        // A normal exit reaps leftovers now; a stopping group may still be printing its summary.
        if (!stopping) signalGroup('SIGKILL');
        const settle = setTimeout(() => { signalGroup('SIGKILL'); finish(code ?? 1); }, stopping ? 2500 : 1000);
        child.once('close', () => { clearTimeout(settle); finish(code ?? 1); });
      });
    });
  }
}

export interface CheckOptions { signal?: AbortSignal; onOutput?: (text: string) => void; onSpawn?: (pid: number) => void }
export interface CheckResult { exitCode: number; output: string; timedOut?: boolean; interrupted?: boolean; durationMs?: number }

/** Child environments never receive model credentials or the tool bridge token. */
export function scrubbedEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|API_KEY|PASSWORD|ROS_BRIDGE/.test(key)));
}
