import { execFile } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';

// Spidermonkey's senses: one frame of the machine per tick. Ordinary code only.
// Processes are grouped into apps ("Google Chrome" includes all its helpers), so a
// frame reads like an activity monitor, not a raw process table.

export interface AppSample {
  key: string;
  name: string;
  kind: 'gui' | 'cli' | 'system';
  processes: number;
  cpu: number;
  rssMb: number;
  /** One scrubbed command line, for CLI processes only. */
  example?: string;
}
export interface PortSample { port: number; app: string }
export interface FileSample { path: string; size: number; lines: string[] }
export interface CommandSample { name: string; command: string; exitCode: number; output: string; durationMs: number; ranAt: number }

export interface Frame {
  at: number;
  apps: Map<string, AppSample>;
  ports: Map<number, PortSample>;
  files: Map<string, FileSample>;
  commands: Map<string, CommandSample>;
}

export const run = (file: string, args: string[], timeout = 10_000) => new Promise<{ code: number; stdout: string }>(done => {
  execFile(file, args, { timeout, maxBuffer: 16_000_000 }, (error, stdout) =>
    done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout) }));
});

/** Remove credentials from command lines before they leave the machine. */
export function scrub(text: string) {
  return text
    .replace(/((?:token|secret|password|passwd|api[_-]?key|auth|bearer|credential)[\w-]*[=: ]+)\S+/gi, '$1<redacted>')
    .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, '<redacted>')
    .replace(/\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, '<redacted>');
}

const system = /^\/(System|usr\/libexec|usr\/sbin|sbin|usr\/bin|bin|Library\/Apple)\//;

/** App identity from an executable path and its arguments. */
export function identify(comm: string, args: string): Omit<AppSample, 'processes' | 'cpu' | 'rssMb'> {
  const bundle = /\/([^/]+)\.app\//.exec(comm);
  // Any bundle in an Applications folder is a user-facing app: /Applications, ~/Applications,
  // Apple's own /System/Applications (Calculator, Notes, Mail) and Safari's Cryptex path.
  // Bundles elsewhere under /System (Dock, Spotlight, XPC helpers) are the OS itself.
  if (bundle) return { key: `app:${bundle[1]}`, name: bundle[1]!, kind: /\/Applications\//.test(comm.slice(0, comm.indexOf(`${bundle[1]}.app`) + 1)) || !system.test(comm) ? 'gui' : 'system' };
  const exe = basename(comm);
  // "(bash)": an exited or zombie process; "[kworker]": a kernel thread.
  if (system.test(comm) || /^[([]/.test(comm) || exe.startsWith('com.apple')) return { key: `sys:${exe}`, name: exe, kind: 'system' };
  if (/\s-(e|c|-eval)\s/.test(` ${args} `)) return { key: `proc:${exe} (inline)`, name: `${exe} (inline script)`, kind: 'cli', example: scrub(args).slice(0, 160) };
  // Interpreters are identified by what they run: "node vite", "python pytest".
  const argv = args.split(/\s+/).slice(1).filter(arg => arg && !arg.startsWith('-'));
  const interpreter = /^(node|python\d*(\.\d+)?|ruby|java|deno|bun|tsx|npx|pnpm|npm|yarn|uv|go)$/.test(exe);
  const target = interpreter && argv[0] ? ` ${basename(argv[0]).replace(/\.(m?js|cjs|ts|py)$/, '')}` : '';
  return { key: `proc:${exe}${target}`, name: `${exe}${target}`, kind: 'cli', example: scrub(args).slice(0, 160) };
}

export async function sampleProcesses(): Promise<Map<string, AppSample>> {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,comm=']);
  const { stdout: full } = await run('ps', ['-axo', 'pid=,args=']);
  const argsByPid = new Map(full.split('\n').map(line => /^\s*(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map(match => [match![1]!, match![2]!]));
  const apps = new Map<string, AppSample>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match || match[1] === String(process.pid)) continue;
    const comm = match[5]!.trim();
    const identity = identify(comm, argsByPid.get(match[1]!) ?? comm);
    const app = apps.get(identity.key) ?? { ...identity, processes: 0, cpu: 0, rssMb: 0 };
    app.processes++;
    app.cpu += Number(match[3]);
    app.rssMb += Number(match[4]) / 1024;
    apps.set(identity.key, app);
  }
  for (const app of apps.values()) { app.cpu = Math.round(app.cpu); app.rssMb = Math.round(app.rssMb); }
  return apps;
}

export async function samplePorts(): Promise<Map<number, PortSample>> {
  const { stdout } = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'cn']);
  const ports = new Map<number, PortSample>();
  let app = '';
  for (const line of stdout.split('\n')) {
    if (line.startsWith('c')) app = line.slice(1);
    const match = /^n.*:(\d+)$/.exec(line);
    if (match) ports.set(Number(match[1]), { port: Number(match[1]), app });
  }
  return ports;
}

/** Appended lines since the last look; the first look only records the size. */
export class FileTails {
  private offsets = new Map<string, number>();
  /** A file whose whole content is news (a log the agent just started): read it from the beginning. */
  fromStart(path: string) { if (!this.offsets.has(path)) this.offsets.set(path, 0); }
  async sample(paths: string[]): Promise<Map<string, FileSample>> {
    const out = new Map<string, FileSample>();
    for (const path of paths) {
      let size: number;
      try { size = (await stat(path)).size; } catch { continue; }
      const offset = this.offsets.get(path);
      this.offsets.set(path, size);
      if (offset === undefined || size <= offset) { out.set(path, { path, size, lines: [] }); continue; }
      const handle = await open(path, 'r');
      try {
        const length = Math.min(size - offset, 256_000);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        out.set(path, { path, size, lines: buffer.toString('utf8').split('\n').filter(line => line.trim()).slice(-200).map(line => scrub(line).slice(0, 400)) });
      } finally { await handle.close(); }
    }
    return out;
  }
}

export async function runCommand(name: string, command: string, cwd: string, timeoutMs: number): Promise<CommandSample> {
  const started = Date.now();
  return new Promise(done => {
    execFile('/bin/sh', ['-c', command], {
      cwd, timeout: timeoutMs, maxBuffer: 4_000_000,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|API_KEY|PASSWORD/.test(key))),
    }, (error, stdout, stderr) => done({ name, command, exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
      output: scrub(String(stdout) + String(stderr)).slice(-6000), durationMs: Date.now() - started, ranAt: started }));
  });
}
