import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServiceSpec } from '../../src/services.js';
import type { HarnessEvent } from '../../src/types.js';

// The dynamic-world suite: small repositories whose environment changes independently of
// the executive (services, workers, queues, the executive's own blocking checks). Each
// task is a template directory under tasks/<id>/:
//   task.json   prompt, environment, check, services, and the hazard event to detect
//   files/      the repository the executive starts from
//   reference/  overlay: a correct solution (calibration only)
//   naive/      overlay: the obvious solution that trips the hazard (calibration only)
//   hidden/     hidden tests; grader.mjs  the objective grader
// Nothing under reference/, naive/, hidden/ or grader.mjs ever enters a workspace
// before grading.

export const root = fileURLToPath(new URL('.', import.meta.url));
export type Hazard = 'escalate' | 'interrupt' | 'no-interrupt' | 'no-escalate';

export interface TaskSpec {
  id: string; hazard: Hazard; summary: string; prompt: string; environment: string; check: string;
  services: ServiceSpec[];
  event?: { file: string; pattern: string; exclude?: string };
  relevantStreams: string[]; relevantPaths: string[];
  /** Written after the design was frozen; never used for development. */
  heldOut?: boolean;
  dir: string;
}

export interface Suite {
  executiveModel: string; executiveReasoning: string; timeoutSeconds: number; maxSteps: number; maxCostUsd: number;
  checkTimeoutSeconds: number; servicesWarmupMs: number; environmentSuffix: string; pollingInstructions: string;
  arms: Record<string, { profile: string; appraiser?: string; poll?: boolean; servicesOnly?: boolean; description: string }>;
}

export async function loadSuite(): Promise<Suite> {
  const suite = JSON.parse(await readFile(join(root, 'suite.json'), 'utf8')) as Suite;
  // Same tasks and arms with another executive; recorded in the run manifest.
  if (process.env.ROS_DYNAMIC_EXECUTIVE_MODEL) suite.executiveModel = process.env.ROS_DYNAMIC_EXECUTIVE_MODEL;
  return suite;
}

/**
 * Development tasks by default. Held-out tasks (`heldOut: true`) were written after the
 * perception design was frozen and are loaded only with `heldOut` or by explicit id.
 */
export async function loadTasks(ids?: string[], options: { heldOut?: boolean } = {}): Promise<TaskSpec[]> {
  const names = (await readdir(join(root, 'tasks'))).sort();
  const tasks: TaskSpec[] = [];
  for (const name of names) {
    if (ids?.length && !ids.includes(name)) continue;
    const dir = join(root, 'tasks', name);
    const spec = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8')) as Omit<TaskSpec, 'dir'>;
    if (!ids?.length && Boolean(spec.heldOut) !== Boolean(options.heldOut)) continue;
    tasks.push({ ...spec, dir });
  }
  if (ids?.length && tasks.length !== ids.length) throw new Error(`Unknown task in ${ids.join(', ')}`);
  return tasks;
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/** A fresh temporary workspace from the task template, optionally with a solution overlay. */
export async function materialize(task: TaskSpec, overlay?: 'reference' | 'naive'): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `ros-dyn-${task.id}-`));
  await cp(join(task.dir, 'files'), workspace, { recursive: true });
  await writeFile(join(workspace, 'package.json'), `${JSON.stringify({ name: task.id, private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`);
  if (task.services.length) {
    await mkdir(join(workspace, 'service'), { recursive: true });
    await cp(join(root, 'shared/service/dev.js'), join(workspace, 'service/dev.js'));
    await mkdir(join(workspace, 'logs'), { recursive: true });
  }
  if (overlay) await cp(join(task.dir, await exists(join(task.dir, overlay)) ? overlay : 'reference'), workspace, { recursive: true });
  return workspace;
}

/** Overlay files as a scripted executive: read each existing file, then write it. */
export async function overlayScript(task: TaskSpec, overlay: 'reference' | 'naive', workspace: string) {
  const base = join(task.dir, await exists(join(task.dir, overlay)) ? overlay : 'reference');
  const steps: Array<Record<string, unknown>> = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      const path = relative(base, full);
      if (await exists(join(workspace, path))) steps.push({ tool: 'read_file', input: { path } });
      steps.push({ tool: 'write_file', input: { path, content: await readFile(full, 'utf8') } });
    }
  };
  await walk(base);
  return steps;
}

export function taskText(task: TaskSpec, suite: Suite, poll: boolean) {
  const parts = [task.prompt];
  if (task.environment) parts.push(`Environment: ${task.environment} ${suite.environmentSuffix}`);
  if (poll && task.services.length) parts.push(suite.pollingInstructions);
  return parts.join('\n\n');
}

export function run(command: string, args: string[], options: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv; log?: string }) {
  return new Promise<{ code: number | null; timedOut: boolean; output: string }>(done => {
    const child = spawn(command, args, { cwd: options.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: options.env ?? process.env });
    let output = '';
    let timedOut = false;
    const append = (data: Buffer) => { output += data.toString('utf8'); if (output.length > 4_000_000) output = output.slice(-2_000_000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const kill = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 5000); }, options.timeoutMs);
    child.on('close', async code => {
      clearTimeout(timer);
      kill('SIGKILL');
      if (options.log) await writeFile(options.log, output, { mode: 0o600 }).catch(() => {});
      done({ code, timedOut, output });
    });
  });
}

export interface Grade { pass: boolean; checks: Array<{ name: string; pass: boolean; detail: string }>; error?: string }

export async function grade(task: TaskSpec, workspace: string): Promise<Grade> {
  const result = await run(process.execPath, [join(task.dir, 'grader.mjs'), workspace], { cwd: workspace, timeoutMs: 240_000 });
  const line = result.output.trim().split('\n').reverse().find(item => item.startsWith('{"pass"'));
  if (!line) return { pass: false, checks: [], error: result.timedOut ? 'grader timed out' : result.output.slice(-2000) };
  return JSON.parse(line) as Grade;
}

// ---------------------------------------------------------------------------
// Trace analysis. Every metric comes from recorded events and world files.

export interface CheckRun { startedAt: number; endedAt: number; seconds: number; timedOut: boolean; interrupted: boolean; exitCode?: number }
export interface Delivery { at: number; stream: string; severity: string; summary: string; relevant: boolean }

export interface AttemptResult {
  task: string; arm: string; repeat: number; mode: string; status: string; error?: string;
  success: boolean; gradeChecks: Grade['checks'];
  elapsedSeconds: number; executiveSteps: number; executiveCostUsd: number | null; executiveInputTokens: number;
  jevCalls: number; jevCostUsd: number | null;
  checks: number; checkSeconds: number; blockedSeconds: number; timeouts: number;
  interrupts: number; falseInterrupts: number; followUps: number; falseFollowUps: number;
  delivered: number; relevantDelivered: number; deliveries: Delivery[];
  eventAt?: number; detectedAt?: number; detectionSeconds?: number; detectedBy?: string;
  brokenSeconds?: number; brokenAtEnd?: boolean;
  startedAt: number; endedAt: number;
  /** The first try failed before any executive step and was rerun. */
  retried?: boolean;
}

const stamp = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/;

/** Timestamped lines of a world file; untimestamped lines (stack traces) inherit the previous time. */
export function timedLines(text: string) {
  let last = 0;
  return text.split('\n').filter(Boolean).map(line => {
    const match = line.match(stamp);
    if (match) last = Date.parse(match[0]);
    return { at: last, line };
  });
}

export function analyze(task: TaskSpec, arm: string, repeat: number, events: HarnessEvent[], world: Record<string, string>,
  metrics: Record<string, any>, graded: Grade): AttemptResult {
  const at = (event: HarnessEvent) => Date.parse(event.at);
  const startedAt = events.length ? at(events.find(event => event.kind === 'prompt') ?? events[0]!) : 0;
  const endedAt = events.length ? Math.max(...events.map(at)) : 0;
  const checks: CheckRun[] = [];
  let pending: number | undefined;
  for (const event of events) {
    if (event.lane === 'executive' && event.kind === 'tool' && event.data?.toolName === 'run_checks') pending = at(event);
    if (event.lane === 'environment' && event.kind === 'result' && event.data?.toolName === 'run_checks' && pending !== undefined) {
      const output = event.data.output as { timedOut?: boolean; interrupted?: boolean; exitCode?: number } | undefined;
      checks.push({ startedAt: pending, endedAt: at(event), seconds: (at(event) - pending) / 1000, timedOut: Boolean(output?.timedOut), interrupted: Boolean(output?.interrupted), exitCode: output?.exitCode });
      pending = undefined;
    }
  }
  const edits = events.filter(event => event.lane === 'environment' && event.kind === 'result' && ['replace_text', 'write_file'].includes(String(event.data?.toolName))
    && (event.data?.output as { written?: boolean } | undefined)?.written).map(at);
  const firstEditAt = edits[0];
  const lastEditAt = edits.at(-1);

  // The hazard event: the first matching world line after the executive's first edit.
  let eventAt: number | undefined;
  let lastMatchAt: number | undefined;
  if (task.event && firstEditAt !== undefined) {
    const pattern = new RegExp(task.event.pattern);
    const exclude = task.event.exclude ? new RegExp(task.event.exclude) : undefined;
    for (const { at: time, line } of timedLines(world[task.event.file] ?? '')) {
      if (time < firstEditAt || !pattern.test(line) || exclude?.test(line)) continue;
      eventAt ??= time;
      lastMatchAt = time;
    }
  }
  if (task.hazard === 'interrupt') {
    const hung = checks.find(check => check.timedOut || check.interrupted);
    if (hung) eventAt = hung.startedAt;
  }

  const relevantStream = (stream: string) => task.relevantStreams.includes(stream);
  const deliveries: Delivery[] = events.filter(event => event.lane === 'system1' && (event.kind === 'finding' || event.kind === 'escalation') && typeof event.data?.key === 'string')
    .map(event => {
      const key = String(event.data!.key);
      const stream = key.slice(0, key.lastIndexOf(':'));
      // Relevant: about the hazard's own streams, before the event (it can prevent it) or after.
      return { at: at(event), stream, severity: String(event.data!.severity), summary: String(event.data!.summary ?? '').slice(0, 300),
        relevant: relevantStream(stream) };
    });
  const followUps = events.filter(event => event.lane === 'executive' && event.kind === 'prompt' && event.data?.source === 'system1-final-gate');
  const interrupts = events.filter(event => event.lane === 'system1' && event.kind === 'interrupt');

  // Detection: the executive has the hazard in context, by delivery or by reading it itself.
  let detectedAt: number | undefined;
  let detectedBy: string | undefined;
  if (eventAt !== undefined) {
    if (task.hazard === 'interrupt') {
      const hung = checks.find(check => check.startedAt === eventAt)!;
      detectedAt = hung.endedAt;
      detectedBy = hung.interrupted ? 'interrupt' : 'timeout';
    } else {
      const delivered = deliveries.find(item => item.relevant && item.at >= eventAt!);
      const read = events.find(event => event.lane === 'executive' && event.kind === 'tool' && at(event) >= eventAt!
        && typeof event.data?.path === 'string' && task.relevantPaths.includes(event.data.path as string));
      const candidates = [delivered && { at: delivered.at, by: `finding:${delivered.stream}` }, read && { at: at(read), by: `read:${read.data!.path}` }]
        .filter(Boolean) as Array<{ at: number; by: string }>;
      const first = candidates.sort((a, b) => a.at - b.at)[0];
      if (first) { detectedAt = first.at; detectedBy = first.by; }
    }
  }
  const serviceStop = events.filter(event => event.lane === 'environment' && event.kind === 'service' && event.data?.kind === 'exited').map(at);
  const worldEnd = serviceStop.length ? Math.min(...serviceStop) : endedAt;
  // Still broken at the end: the hazard kept recurring after the executive's last edit had taken effect.
  const brokenAtEnd = lastMatchAt !== undefined && lastEditAt !== undefined && lastMatchAt > lastEditAt + 3000;

  const executive = (metrics.executive ?? {}) as { steps?: number; costUsd?: number | null; inputTokens?: number };
  const system1 = (metrics.system1 ?? {}) as { calls?: number; costUsd?: number | null };
  const noInterrupt = task.hazard === 'no-interrupt';
  const distractor = task.hazard === 'no-interrupt' || task.hazard === 'no-escalate';
  return {
    task: task.id, arm, repeat, mode: String(metrics.mode ?? 'unknown'), status: String(metrics.status ?? 'missing'), error: metrics.error,
    success: graded.pass, gradeChecks: graded.checks,
    elapsedSeconds: Number(metrics.elapsedSeconds ?? 0), executiveSteps: executive.steps ?? 0, executiveCostUsd: executive.costUsd ?? null,
    executiveInputTokens: executive.inputTokens ?? 0, jevCalls: system1.calls ?? 0, jevCostUsd: system1.costUsd ?? null,
    checks: checks.length, checkSeconds: round(checks.reduce((sum, check) => sum + check.seconds, 0)),
    blockedSeconds: round(checks.filter(check => check.timedOut || check.interrupted).reduce((sum, check) => sum + check.seconds, 0)),
    timeouts: checks.filter(check => check.timedOut).length,
    interrupts: interrupts.length, falseInterrupts: noInterrupt ? interrupts.length : 0,
    followUps: followUps.length, falseFollowUps: distractor ? followUps.length : 0,
    delivered: deliveries.length, relevantDelivered: deliveries.filter(item => item.relevant).length, deliveries,
    eventAt, detectedAt, detectionSeconds: eventAt !== undefined && detectedAt !== undefined ? round((detectedAt - eventAt) / 1000) : undefined, detectedBy,
    ...(eventAt !== undefined && task.hazard === 'escalate' ? { brokenSeconds: round(((brokenAtEnd ? worldEnd : lastMatchAt ?? eventAt) - eventAt) / 1000), brokenAtEnd } : {}),
    startedAt, endedAt,
  };
}

const round = (value: number) => Math.round(value * 10) / 10;

/** World files worth keeping with the trace: logs and queues. */
export async function collectWorld(workspace: string) {
  const world: Record<string, string> = {};
  for (const directory of ['logs', 'queue']) {
    const entries = await readdir(join(workspace, directory)).catch(() => [] as string[]);
    for (const name of entries) {
      const path = `${directory}/${name}`;
      const text = await readFile(join(workspace, path), 'utf8').catch(() => '');
      world[path] = text.length > 2_000_000 ? text.slice(-2_000_000) : text;
    }
  }
  return world;
}

export const repoRoot = resolve(root, '../..');

/**
 * A private project root for one attempt's Eve dev server. Eve keeps workflow state, locks
 * and cleanup intents in `<project>/.eve/`, so concurrent attempts must not share one.
 * The authored agent, sources and dependencies are symlinked, not copied.
 */
export async function privateProject() {
  const project = await mkdtemp(join(tmpdir(), 'ros-dyn-eve-'));
  for (const name of ['agent', 'src', 'node_modules']) await symlink(join(repoRoot, name), join(project, name));
  for (const name of ['package.json', 'tsconfig.json']) await cp(join(repoRoot, name), join(project, name));
  return project;
}
