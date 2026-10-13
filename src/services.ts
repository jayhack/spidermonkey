import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { scrubbedEnvironment } from './workspace.js';

// Background processes the harness starts for a task: dev servers, workers, producers.
// They run in the workspace, in their own process groups, and write to a log file
// that both the executive (read_file) and perception (log sensor) can see. They are
// children of the harness, so the process sensor observes them too.

export interface ServiceSpec { name: string; command: string; log: string }

export interface ServiceEvent { name: string; kind: 'started' | 'exited'; pid?: number; code?: number | null; signal?: string | null }

export async function startServices(root: string, specs: ServiceSpec[], onEvent: (event: ServiceEvent) => void = () => {}) {
  const children: Array<{ spec: ServiceSpec; child: ChildProcess; exited: Promise<void> }> = [];
  for (const spec of specs) {
    const log = resolve(root, spec.log);
    await mkdir(dirname(log), { recursive: true });
    const handle = await open(log, 'a');
    const child = spawn('/bin/sh', ['-c', spec.command], { cwd: root, detached: true, stdio: ['ignore', handle.fd, handle.fd], env: scrubbedEnvironment() });
    await handle.close();
    const exited = new Promise<void>(done => child.once('exit', (code, signal) => { onEvent({ name: spec.name, kind: 'exited', pid: child.pid, code, signal }); done(); }));
    child.once('error', () => {});
    onEvent({ name: spec.name, kind: 'started', pid: child.pid });
    children.push({ spec, child, exited });
  }
  return {
    pids: () => children.map(item => item.child.pid).filter((pid): pid is number => typeof pid === 'number'),
    async stop() {
      const group = (child: ChildProcess, signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch {} };
      for (const { child } of children) group(child, 'SIGTERM');
      await Promise.race([Promise.all(children.map(item => item.exited)), new Promise(done => setTimeout(done, 2000))]);
      for (const { child } of children) group(child, 'SIGKILL');
    },
  };
}
