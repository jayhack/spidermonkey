import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { appendFile, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { S1Evaluate } from '../monitor.js';
import { FileTails, runCommand, sampleProcesses, samplePorts, type CommandSample, type Frame } from './machine.js';
import { Spidermonkey, type AgentStep, type Entity, type FeedItem, type Options } from './core.js';

// The daemon: samples a frame every interval, feeds Spidermonkey, keeps registered
// watches on disk, tails an agent trace, and serves a small API on a Unix socket.

export interface DaemonOptions extends Options {
  home: string;
  cwd: string;
  intervalMs: number;
  /** An agent trace to tail: ROS harness events.jsonl, or JSONL lines {kind, text}. */
  trace?: string;
  evaluate?: S1Evaluate;
  /** Tests inject frames instead of sampling the machine. */
  sampler?: (files: string[]) => Promise<Omit<Frame, 'commands'>>;
}

/** Unix socket paths are limited to about 104 bytes on macOS; long homes use a short hashed path. */
export const socketPath = (home: string) => {
  const path = join(home, 'sock');
  return path.length <= 100 ? path : join('/tmp', `spidermonkey-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
};

export class Daemon {
  readonly monkey: Spidermonkey;
  private timer?: ReturnType<typeof setTimeout>;
  private server?: Server;
  private tails = new FileTails();
  private running = new Map<string, Promise<void>>();
  private finished = new Map<string, CommandSample>();
  private lastRun = new Map<string, number>();
  private traceOffset = 0;
  private stopped = false;

  constructor(private options: DaemonOptions) {
    this.monkey = new Spidermonkey(options, options.evaluate);
    this.monkey.on(item => { void appendFile(join(options.home, 'feed.jsonl'), JSON.stringify(item) + '\n').catch(() => {}); });
  }

  async start({ serve = true } = {}) {
    await mkdir(this.options.home, { recursive: true });
    for (const entity of await this.loadWatches()) this.monkey.register({ ...entity, reason: entity.reason ?? 'registered earlier' });
    if (this.options.trace) {
      // Only new steps: an existing trace is history, not the present.
      try { this.traceOffset = (await stat(this.options.trace)).size; } catch { this.traceOffset = 0; }
    }
    if (serve) await this.serve();
    const loop = async () => {
      if (this.stopped) return;
      try { await this.tick(); } catch (error) { this.monkey.emit({ type: 'error', at: Date.now(), message: error instanceof Error ? error.message : String(error) }); }
      if (!this.stopped) this.timer = setTimeout(loop, this.options.intervalMs);
    };
    void loop();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await new Promise<void>(done => this.server ? this.server.close(() => done()) : done());
    await rm(socketPath(this.options.home), { force: true });
  }

  async tick() {
    await this.readTrace();
    const now = Date.now();
    const due = this.monkey.due(now);
    // Commands run in the background; a frame carries the results that finished since the last frame.
    for (const entity of due.commands) {
      const every = (entity.spec?.everySeconds ?? 30) * 1000;
      if (this.running.has(entity.id) || now - (this.lastRun.get(entity.id) ?? 0) < every) continue;
      this.lastRun.set(entity.id, now);
      const name = entity.id.replace(/^command:/, '');
      const job = runCommand(name, entity.spec!.command!, this.options.cwd, Math.max(10_000, every * 4)).then(sample => { this.finished.set(name, sample); })
        .finally(() => this.running.delete(entity.id));
      this.running.set(entity.id, job);
    }
    // One read per file per tick, however many entities name it: a second read would see no new lines.
    const files = [...new Set(due.files.map(path => isAbsolute(path) ? path : resolve(this.options.cwd, path)))];
    const base = this.options.sampler ? await this.options.sampler(files)
      : { at: now, apps: await sampleProcesses(), ports: await samplePorts(), files: await this.tails.sample(files) };
    const commands = new Map(this.finished);
    this.finished.clear();
    await this.monkey.tick({ ...base, commands });
  }

  /** Treat everything already in this file as new: it belongs to a process just started. */
  readFromStart(path: string) { this.tails.fromStart(isAbsolute(path) ? path : resolve(this.options.cwd, path)); }

  /** Wait for background commands (tests use this to make ticks deterministic). */
  async settle() { await Promise.all(this.running.values()); }

  private async readTrace() {
    if (!this.options.trace) return;
    let size: number;
    try { size = (await stat(this.options.trace)).size; } catch { return; }
    if (size <= this.traceOffset) { this.traceOffset = Math.min(this.traceOffset, size); return; }
    const handle = await open(this.options.trace, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(size - this.traceOffset, 2_000_000));
      await handle.read(buffer, 0, buffer.length, this.traceOffset);
      const text = buffer.toString('utf8');
      const complete = text.lastIndexOf('\n') + 1;
      this.traceOffset += Buffer.byteLength(text.slice(0, complete));
      for (const line of text.slice(0, complete).split('\n').filter(Boolean)) {
        try { const step = toStep(JSON.parse(line)); if (step) this.monkey.ingest(step); } catch { /* not JSON */ }
      }
    } finally { await handle.close(); }
  }

  private watchesFile() { return join(this.options.home, 'watches.json'); }
  private async loadWatches(): Promise<Entity[]> {
    try { return JSON.parse(await readFile(this.watchesFile(), 'utf8')) as Entity[]; } catch { return []; }
  }
  private async saveWatches() {
    const registered = [...this.monkey.entities.values()].filter(entity => entity.source === 'registered');
    await writeFile(this.watchesFile(), JSON.stringify(registered, null, 2) + '\n');
  }

  private async serve() {
    const path = socketPath(this.options.home);
    await rm(path, { force: true });
    const feeds = new Set<(item: FeedItem) => void>();
    this.monkey.on(item => { for (const feed of feeds) feed(item); });
    this.server = createServer(async (request, response) => {
      const send = (status: number, body: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      try {
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > 1_000_000) throw new Error('Request too large'); }
        const input = body ? JSON.parse(body) : {};
        if (request.method === 'GET' && request.url === '/status') return send(200, this.monkey.status());
        if (request.method === 'POST' && request.url === '/drain') return send(200, this.monkey.drain());
        if (request.method === 'POST' && request.url === '/watch') { const entity = this.monkey.register({ ...input, source: 'registered' }); await this.saveWatches(); return send(200, entity); }
        if (request.method === 'POST' && request.url === '/unwatch') { const ok = this.monkey.unregister(String(input.id)); await this.saveWatches(); return send(ok ? 200 : 404, { ok }); }
        if (request.method === 'POST' && request.url === '/trace') { for (const step of [input].flat()) this.monkey.ingest({ at: Date.now(), kind: step.kind ?? 'message', text: String(step.text ?? '') }); return send(200, { ok: true }); }
        if (request.method === 'GET' && request.url === '/feed') {
          response.writeHead(200, { 'content-type': 'application/x-ndjson' });
          const feed = (item: FeedItem) => response.write(JSON.stringify(item) + '\n');
          feeds.add(feed);
          request.on('close', () => feeds.delete(feed));
          return;
        }
        send(404, { error: 'not found' });
      } catch (error) { send(400, { error: error instanceof Error ? error.message : String(error) }); }
    });
    await new Promise<void>((done, fail) => { this.server!.once('error', fail); this.server!.listen(path, done); });
  }
}

/** One agent step from a trace line: ROS harness events, or a generic {kind, text}. */
export function toStep(line: Record<string, unknown>): AgentStep | undefined {
  const at = typeof line.at === 'string' ? Date.parse(line.at) : Date.now();
  const data = (line.data ?? {}) as Record<string, unknown>;
  if (line.lane === 'executive' && line.kind === 'message') return { at, kind: 'message', text: String(line.message ?? '') };
  if (line.lane === 'executive' && line.kind === 'prompt') return { at, kind: 'prompt', text: String(line.message ?? '') };
  if (line.lane === 'executive' && line.kind === 'tool') return { at, kind: 'tool', text: `${String(data.toolName ?? line.message)}${data.path ? ` ${String(data.path)}` : ''}${data.query ? ` "${String(data.query)}"` : ''}${data.command ? ` (${String(data.command)})` : ''}` };
  if (line.lane === 'environment' && line.kind === 'result') return { at, kind: 'result', text: String(line.message ?? '').slice(0, 400) };
  if (!line.lane && typeof line.text === 'string') return { at, kind: (line.kind as AgentStep['kind']) ?? 'message', text: line.text };
  return undefined;
}
