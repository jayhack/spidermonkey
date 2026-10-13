import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { digest } from '../workspace.js';
import type { BlockingCall, Finding, Monitor, MonitorContext, MonitorFactory, ToolEvent } from '../monitor.js';
import { defaultGrounding, ground, type GroundingOptions } from '../grounding.js';
import { deliverAll, deliverNone, escalateAll, normalizeForNovelty, Perception, rulesAppraiser, system1Appraiser, type Appraiser, type Observation } from '../perception.js';
import { observeDiff, observeStatic } from './integrity.js';

// The perceptual system as a monitor: configurable sensors feeding one shared
// System 1 appraisal. Profiles select sensors and the appraiser (or an ablation).
//
// {
//   "appraiser": "system1" | "deliver-all" | "escalate-all" | "deliver-none" | "rules",
//   "threshold": 0.5, "escalateAt": 2, "interruptAt": 0.55, "maxAppraisals": 80, "minSeverity": "warn",
//   "commands": [{ "name": "tests", "command": "$CHECK", "on": ["start", "edit"], "debounceMs": 400, "timeoutMs": 120000, "serveRunChecks": true }],
//   "processes": { "everyMs": 2000 },
//   "logs": { "paths": ["logs/*.log", "queue/*.jsonl"], "everyMs": 1000, "maxLines": 40 },
//   "blocking": { "everyMs": 2000, "patienceSeconds": 8 },
//   "grounding": { "mode": "system1", "maxLocations": 2 },
//   "integrity": { "static": true, "diff": true, "python": ["python3"], "debounceMs": 300, "finalGate": true },
//   "settleMs": 5000
// }
//
// Sensors, all read-only with respect to workspace files:
// - commands: background observation commands (a watch-mode test runner); "start" takes a
//   baseline so appraisal can tell new problems from pre-existing ones.
// - processes: an htop-like table of harness-started processes, with RSS trends.
// - logs: append-only files (service logs, JSONL queues), habituated to line templates
//   already seen so routine churn never costs an appraisal.
// - blocking: the executive's own blocking call (run_checks): live output, silence,
//   and its process subtree. System 1 may interrupt it, which stops the call's process
//   group and returns the partial output with the finding; the interrupt is recorded.
// - integrity (src/monitors/integrity.ts): static checks and the cumulative diff after each
//   edit, appraised as self-observations (is the change warranted by the task?).
// Actions: grounding attaches the source an alarm points to; the final gate re-raises
// integrity concerns still true of the final code and world problems still happening.

type Trigger = 'edit' | 'tick' | 'start';
interface IntegrityConfig { static: boolean; diff: boolean; python: string[]; debounceMs: number; finalGate: boolean }
interface CommandSensor { name: string; command: string; on: Trigger[]; debounceMs: number; timeoutMs: number; serveRunChecks: boolean; everyMs: number }
interface TemplateState { lastSeenAt: number; lastLine: string; problem: boolean }
interface LogConfig { paths: string[]; everyMs: number; maxLines: number }
interface BlockingConfig { everyMs: number; patienceSeconds: number }

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function appraiserFor(name: unknown, context: MonitorContext): Appraiser {
  return name === 'deliver-all' ? deliverAll : name === 'escalate-all' ? escalateAll : name === 'deliver-none' ? deliverNone : name === 'rules' ? rulesAppraiser : system1Appraiser(context);
}

export const perceptionMonitor: MonitorFactory = (config, context) => {
  const appraiser = appraiserFor(config.appraiser, context);
  const grounding: GroundingOptions | undefined = config.grounding ? { ...defaultGrounding, ...(config.grounding as Partial<GroundingOptions>) } : undefined;
  const perception = new Perception(context, appraiser, { threshold: Number(config.threshold ?? 0.5), escalateAt: Number(config.escalateAt ?? 2),
    interruptAt: Number(config.interruptAt ?? 0.55), ...(config.maxAppraisals === undefined ? {} : { maxAppraisals: Number(config.maxAppraisals) }),
    ...(config.minSeverity ? { minSeverity: config.minSeverity as 'info' | 'warn' | 'error' } : {}) });
  const sensors: CommandSensor[] = ((config.commands as Array<Partial<Omit<CommandSensor, 'on'>> & { on?: Trigger | Trigger[] }> | undefined) ?? []).map(sensor => ({
    name: sensor.name ?? 'command', command: sensor.command ?? '$CHECK', on: [sensor.on ?? 'edit'].flat(), debounceMs: sensor.debounceMs ?? 400,
    timeoutMs: sensor.timeoutMs ?? 120_000, serveRunChecks: sensor.serveRunChecks ?? false, everyMs: sensor.everyMs ?? 10_000,
  }));
  const processes = config.processes as { everyMs?: number } | undefined;
  const integrityConfig = config.integrity as Partial<IntegrityConfig> | undefined;
  const integrity: IntegrityConfig | undefined = integrityConfig && {
    static: integrityConfig.static ?? true, diff: integrityConfig.diff ?? true, python: integrityConfig.python ?? ['python3', 'python'],
    debounceMs: integrityConfig.debounceMs ?? 300, finalGate: integrityConfig.finalGate ?? true };
  const logsConfig = config.logs as Partial<LogConfig> | undefined;
  const logs: LogConfig | undefined = logsConfig ? { paths: logsConfig.paths ?? ['logs/*.log'], everyMs: logsConfig.everyMs ?? 1000, maxLines: logsConfig.maxLines ?? 40 } : undefined;
  const blockingConfig = config.blocking as Partial<BlockingConfig> | undefined;
  const blocking: BlockingConfig | undefined = blockingConfig ? { everyMs: blockingConfig.everyMs ?? 2000, patienceSeconds: blockingConfig.patienceSeconds ?? 8 } : undefined;
  const settleMs = Number(config.settleMs ?? 5000);
  const commandOf = (sensor: CommandSensor, edited: string[]) => sensor.command
    .replaceAll('$CHECK', context.workspace.checkCommand)
    .replaceAll('{edited}', edited.map(shellQuote).join(' '));

  // Latest run per sensor: the edit revision it observed and its result.
  const runs = new Map<string, { editRevision: number; command: string; result: Promise<{ exitCode: number; output: string } | undefined>; abort: AbortController }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const editedSince = new Map<string, Set<string>>();
  const lastTick = new Map<string, number>();
  const tails = new LogTails(context, logs);
  const table = new ProcessTable(context);
  let active: BlockingCall | undefined;
  let interruptKey: string | undefined;

  perception.setRouted(async (observation, appraisal, finding, interrupt) => {
    if (observation.source === 'logs' && perception.isProblem(appraisal)) tails.markProblem(observation);
    if (grounding && finding && !interrupt) {
      const source = await ground(observation, appraisal, finding, context, grounding);
      if (source) finding.evidence = `${finding.evidence}\n\nSource this observation points to (exact current file text; counts as read):\n${source}`;
    }
    // Interrupts are the one action perception takes on the world: stop the blocked call.
    if (!interrupt || !finding || !active || !observation.interruptible || active.signal.aborted) return;
    interruptKey = finding.key;
    active.interrupt(finding);
  });

  const launch = (sensor: CommandSensor) => {
    const editRevision = context.editRevision();
    const edited = [...(editedSince.get(sensor.name) ?? [])];
    editedSince.set(sensor.name, new Set());
    const command = commandOf(sensor, edited);
    runs.get(sensor.name)?.abort.abort();
    const abort = new AbortController();
    const result = perception.track((async () => {
      context.emit('sensor', `${sensor.name}: running at edit revision ${editRevision}`, { sensor: sensor.name, editRevision });
      const outcome = await context.run(command, { timeoutMs: sensor.timeoutMs, signal: abort.signal });
      // A newer edit superseded this run; its observation would describe old code.
      if (abort.signal.aborted || context.editRevision() !== editRevision) return undefined;
      const observation: Observation = { stream: sensor.name, source: `command:${sensor.name}`, editRevision,
        content: outcome.output, facts: { exitCode: outcome.exitCode, durationMs: outcome.durationMs, timedOut: outcome.timedOut },
        noveltyKey: `${outcome.exitCode}:${outcome.timedOut}:${normalizeForNovelty(outcome.output)}` };
      await perception.observe(observation);
      return { exitCode: outcome.exitCode, output: outcome.output };
    })());
    runs.set(sensor.name, { editRevision, command, result, abort });
  };

  const waiting = new Map<string, () => void>();
  const cancel = (name: string) => {
    clearTimeout(timers.get(name));
    timers.delete(name);
    waiting.get(name)?.();
    waiting.delete(name);
  };
  const debounce = (name: string, delayMs: number, run: () => void) => {
    cancel(name);
    // Debounce bursts of edits (several replace_text calls in one executive step).
    perception.track(new Promise<void>(resolve => {
      waiting.set(name, resolve);
      timers.set(name, setTimeout(() => { cancel(name); run(); }, delayMs));
    }));
  };
  const schedule = (sensor: CommandSensor) => debounce(sensor.name, sensor.debounceMs, () => launch(sensor));

  // Integrity state: every path edited this session, and the executive's latest check.
  const changed = new Set<string>();
  let lastCheck: { exitCode: number; editRevision: number } | undefined;
  let integrityAbort: AbortController | undefined;
  const integrityStreams = () => [...(integrity?.static ? ['static'] : []), ...(integrity?.diff ? ['diff'] : [])];
  const observeIntegrity = async (signal: AbortSignal) => {
    const edited = [...changed];
    const [staticObservation, diffObservation] = await Promise.all([
      integrity?.static ? observeStatic(context, edited, integrity.python, signal) : undefined,
      integrity?.diff ? observeDiff(context, edited, signal) : undefined,
    ]);
    return { static: staticObservation, diff: diffObservation } as Record<string, Observation | undefined>;
  };
  const runIntegrity = () => {
    integrityAbort?.abort();
    const abort = new AbortController();
    integrityAbort = abort;
    const editRevision = context.editRevision();
    perception.track((async () => {
      context.emit('sensor', `integrity: observing edit revision ${editRevision}`, { sensor: 'integrity', editRevision });
      const current = await observeIntegrity(AbortSignal.any([abort.signal, context.signal]));
      // A newer edit superseded this observation.
      if (abort.signal.aborted || context.editRevision() !== editRevision) return;
      for (const stream of integrityStreams()) {
        const observation = current[stream];
        // Nothing wrong is the quiet state: no appraisal, and a recurrence is news again.
        if (observation) await perception.observe(observation); else perception.forget(stream);
      }
    })()).catch(error => context.emit('error', `integrity sensor failed: ${error instanceof Error ? error.message : String(error)}`));
  };

  const sampleLogs = async () => { for (const observation of await tails.sample()) await perception.observe(observation); };
  const sampleTable = async () => {
    const observation = await table.sample(active?.pid());
    if (observation) await perception.observe(observation);
  };
  const sampleBlocking = async () => {
    const call = active;
    if (!call || call.signal.aborted) return;
    const elapsed = (Date.now() - call.startedAt) / 1000;
    if (!blocking || elapsed < blocking.patienceSeconds) return;
    const observation = await table.blocking(call);
    if (observation && !call.signal.aborted) await perception.observe(observation);
    // The call ended while System 1 was appraising: its own result supersedes the finding.
    if (call.signal.aborted) perception.discard(finding => finding.monitor === 'blocking' && finding.key !== interruptKey);
  };

  /**
   * Re-observe the final code. A concern System 1 escalated during the run and that is
   * still true of the final code is unresolved; it becomes a follow-up request with the
   * executive's latest check status. No new evaluation: the decision was made when the
   * concern appeared (appraising the answer text alongside it was less discriminative).
   */
  const integrityGate = async (): Promise<string | undefined> => {
      if (!integrity?.finalGate || !changed.size) return undefined;
      await perception.settle();
      const current = Object.values(await observeIntegrity(context.signal)).filter((item): item is Observation => Boolean(item));
      // Unchanged observations are not novel and cost nothing; a missed one is appraised now.
      for (const observation of current) await perception.observe(observation);
      const unresolved = current.map(observation => perception.unresolved(observation)).filter((finding): finding is Finding => Boolean(finding));
      if (!unresolved.length) return undefined;
      // This request carries them; do not also report an undelivered copy.
      perception.discard(finding => unresolved.includes(finding));
      const editRevision = context.editRevision();
      const check = !lastCheck ? 'You did not run run_checks.' : lastCheck.editRevision === editRevision
        ? `Your latest run_checks exited ${lastCheck.exitCode} on the final code.` : `Your latest run_checks (exit ${lastCheck.exitCode}) ran before your final edit.`;
      context.emit('escalation', `final gate: ${unresolved.length} unresolved integrity finding(s)`, { findings: unresolved.map(finding => finding.key) });
      return [`Still true of your final code (edit revision ${editRevision}); System 1 escalated it earlier. ${check}`,
        ...unresolved.map(finding => `${finding.summary}${finding.probability === undefined ? '' : ` (P=${finding.probability.toFixed(2)})`}\n${finding.evidence ?? ''}`)].join('\n');
  };

  /** World sensors: is anything flagged as a problem still happening after the last edit took effect? */
  const worldGate = async (): Promise<string | undefined> => {
      // Background processes react to an edit with some delay (reload, restart, next job):
      // look once more after a short grace period before the executive's answer stands.
      if (logs || processes) {
        const since = Date.now() - context.lastEditAt();
        if (context.lastEditAt() && since < settleMs) await new Promise(resolve => setTimeout(resolve, settleMs - since));
        await Promise.all([logs ? perception.track(sampleLogs()) : undefined, processes ? perception.track(sampleTable()) : undefined]);
      }
      await perception.settle();
      // The gate's question: is anything System 1 flagged as a problem still happening after
      // the executive's last edit took effect? Delivered once or not, it is unresolved.
      if (!context.lastEditAt()) return undefined;
      const since = context.lastEditAt() + 2000;
      // World sensors only: logs (a flagged template recurring is a second look) and the
      // process table (two problem appraisals after the edit).
      const persisting = [...tails.recurringProblems(since), ...perception.persistingProblems(since, 2).filter(item => item.stream === 'processes')];
      if (!persisting.length) return undefined;
      perception.discard(finding => persisting.some(item => finding.key.startsWith(`${item.stream}:`)));
      return ['Still observed after your last edit took effect (System 1 flagged these as problems):',
        ...persisting.map(item => `- ${item.stream}:\n${item.lines.map(line => `    ${line}`).join('\n')}`)].join('\n');
  };

  const monitor: Monitor = {
    name: 'perception',
    async intercept(name) {
      if (name !== 'run_checks') return undefined;
      const sensor = sensors.find(item => item.serveRunChecks && commandOf(item, []) === context.workspace.checkCommand);
      if (!sensor) return undefined;
      if (timers.has(sensor.name)) { cancel(sensor.name); launch(sensor); }
      const run = runs.get(sensor.name);
      // Only an observation of the exact current code can stand in for the executive's check.
      if (!run || run.editRevision !== context.editRevision() || run.command !== context.workspace.checkCommand) return undefined;
      const result = await run.result;
      if (!result) return undefined;
      // The executive now sees this observation as its tool result; do not report it twice.
      perception.discard(finding => finding.monitor === `command:${sensor.name}` && finding.editRevision === run.editRevision);
      return { ...result, observedBy: `system1 ${sensor.name} sensor at edit revision ${run.editRevision}` };
    },
    afterTool(event: ToolEvent) {
      perception.noteTool(event);
      const exitCode = (event.output as { exitCode?: unknown } | undefined)?.exitCode;
      if (event.name === 'run_checks' && typeof exitCode === 'number') lastCheck = { exitCode, editRevision: event.editRevision };
      if (!event.edited.length) return;
      if (integrity) {
        for (const path of event.edited) changed.add(path);
        debounce('integrity', integrity.debounceMs, runIntegrity);
      }
      for (const sensor of sensors.filter(item => item.on.includes('edit'))) {
        const set = editedSince.get(sensor.name) ?? new Set<string>();
        for (const path of event.edited) set.add(path);
        editedSince.set(sensor.name, set);
        schedule(sensor);
      }
    },
    blocking(call) {
      if (!blocking) return;
      active = call;
      interruptKey = undefined;
      call.signal.addEventListener('abort', () => {
        if (active === call) active = undefined;
        // Remember how long a run that finished on its own took: the next run's baseline.
        const seconds = (Date.now() - call.startedAt) / 1000;
        if (!interruptKey && seconds * 1000 < context.workspace.checkTimeoutMs * 0.95) table.recordCompletion(call.command, seconds);
        // The executive now sees the call's own result; only the interrupt finding explains anything new.
        perception.discard(finding => finding.monitor === 'blocking' && finding.key !== interruptKey);
      }, { once: true });
    },
    async tick() {
      const now = Date.now();
      for (const sensor of sensors.filter(item => item.on.includes('tick'))) {
        if (now - (lastTick.get(sensor.name) ?? 0) < sensor.everyMs) continue;
        lastTick.set(sensor.name, now);
        launch(sensor);
      }
      const due = (name: string, everyMs: number) => {
        if (now - (lastTick.get(name) ?? 0) < everyMs) return false;
        lastTick.set(name, now);
        return true;
      };
      const work: Array<Promise<unknown>> = [];
      if (blocking && active && due('blocking', blocking.everyMs)) work.push(perception.track(sampleBlocking()));
      if (logs && due('logs', logs.everyMs)) work.push(perception.track(sampleLogs()));
      if (processes && due('processes', processes.everyMs ?? 2000)) work.push(perception.track(sampleTable()));
      await Promise.all(work);
    },
    settle: () => perception.settle(),
    drain: (): Finding[] => perception.drain(),
    async finalGate() {
      const requests = [await integrityGate(), await worldGate()].filter((text): text is string => Boolean(text));
      return requests.length ? requests.join('\n\n') : undefined;
    },
    async stop() {
      for (const name of [...timers.keys()]) cancel(name);
      for (const run of runs.values()) run.abort.abort();
      integrityAbort?.abort();
    },
  };
  for (const sensor of sensors.filter(item => item.on.includes('start'))) launch(sensor);
  return monitor;
};

/** Line templates: timestamps, ids and numbers vary; the shape of the line does not. */
export function lineTemplate(line: string) {
  return line
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z?/g, '<t>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<h>')
    .replace(/\d+(?:[.,]\d+)*/g, '<n>')
    .trim().slice(0, 300);
}

/**
 * Tails append-only files under the workspace. Perception habituates per stream: a line
 * whose template was already seen is routine and never reaches the appraiser; only
 * batches with a never-seen template become observations.
 */
export class LogTails {
  private files = new Map<string, { offset: number; partial: string; templates: Map<string, TemplateState> }>();
  /** Novel templates of each observation, by novelty key, so an appraisal can mark them. */
  private batches = new Map<string, string[]>();
  constructor(private context: MonitorContext, private config: LogConfig | undefined) {}

  /** System 1 judged this observation a problem: remember its templates as problem lines. */
  markProblem(observation: Observation) {
    const path = observation.paths?.[0];
    const state = path ? this.files.get(path) : undefined;
    for (const template of this.batches.get(observation.noveltyKey ?? '') ?? []) {
      const known = state?.templates.get(template);
      if (known) known.problem = true;
    }
  }

  /**
   * Problem lines that recurred since `since`. Habituation hides repeats from the
   * appraiser; this is how perception still knows a flagged failure keeps happening.
   */
  recurringProblems(since: number) {
    const found: Array<{ stream: string; lines: string[] }> = [];
    for (const [path, state] of this.files) {
      const lines = [...state.templates.values()].filter(item => item.problem && item.lastSeenAt >= since).map(item => item.lastLine);
      if (lines.length) found.push({ stream: `log:${path}`, lines: lines.slice(0, 8) });
    }
    return found;
  }

  private async expand(): Promise<string[]> {
    if (!this.config) return [];
    const root = await realpath(this.context.workspace.root);
    const found: string[] = [];
    for (const pattern of this.config.paths) {
      const directory = resolve(root, dirname(pattern));
      if (directory !== root && !directory.startsWith(root + sep)) continue;
      const matcher = new RegExp(`^${basename(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]')}$`);
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) if (entry.isFile() && matcher.test(entry.name)) found.push(relative(root, join(directory, entry.name)));
    }
    return [...new Set(found)].sort();
  }

  async sample(): Promise<Observation[]> {
    if (!this.config) return [];
    const observations: Observation[] = [];
    const root = await realpath(this.context.workspace.root);
    for (const path of await this.expand()) {
      const full = resolve(root, path);
      const canonical = await realpath(full).catch(() => undefined);
      if (!canonical || !canonical.startsWith(root + sep)) continue;
      const state = this.files.get(path) ?? { offset: 0, partial: '', templates: new Map<string, TemplateState>() };
      this.files.set(path, state);
      const size = (await stat(canonical).catch(() => undefined))?.size ?? 0;
      if (size < state.offset) { state.offset = 0; state.partial = ''; }
      if (size === state.offset) continue;
      const limit = 256_000;
      const start = Math.max(state.offset, size - limit);
      const skipped = start - state.offset;
      const handle = await open(canonical, 'r');
      let text: string;
      try {
        const buffer = Buffer.alloc(size - start);
        await handle.read(buffer, 0, buffer.length, start);
        text = buffer.toString('utf8');
      } finally { await handle.close(); }
      state.offset = size;
      const lines = (skipped ? text : state.partial + text).split('\n');
      state.partial = lines.pop() ?? '';
      const novel: string[] = [];
      let routine = 0;
      let lastRoutine = '';
      const now = Date.now();
      for (const line of lines) {
        if (!line.trim()) continue;
        const template = lineTemplate(line);
        const known = state.templates.get(template);
        if (known) { known.lastSeenAt = now; known.lastLine = line.slice(0, 400); routine++; lastRoutine = line; continue; }
        state.templates.set(template, { lastSeenAt: now, lastLine: line.slice(0, 400), problem: false });
        novel.push(line.slice(0, 400));
      }
      if (!novel.length) continue;
      this.batches.set(digest(novel.map(lineTemplate).join('\n')), novel.map(lineTemplate));
      const shown = novel.slice(0, this.config.maxLines);
      const content = [
        `${path}: ${lines.filter(line => line.trim()).length} new lines${skipped ? ` (${skipped} earlier bytes skipped)` : ''}; ${novel.length} with a pattern not seen before on this stream:`,
        ...shown.map(line => `  ${line}`),
        ...(novel.length > shown.length ? [`  … ${novel.length - shown.length} more new-pattern lines`] : []),
        ...(routine ? [`(${routine} routine lines matching earlier patterns omitted; latest: ${lastRoutine.slice(0, 200)})`] : []),
      ].join('\n');
      observations.push({ stream: `log:${path}`, source: 'logs', editRevision: this.context.editRevision(), content,
        facts: { newLines: novel.length + routine, newPatterns: novel.length }, paths: [path], noveltyKey: digest(novel.map(lineTemplate).join('\n')) });
    }
    return observations;
  }
}

interface Row { pid: number; ppid: number; cpu: number; rssMb: number; seconds: number; command: string; args: string }

// The harness's own runtime (Eve dev server, tsx loader, esbuild service, the sampler's
// `ps`) is not part of the world the executive is working in.
const harnessProcess = /[/\s]eve(?:\.js)?\s+dev\b|node_modules\/.*\/eve\/bin\/eve\.js|\btsx\b|\besbuild\b|^(?:\/bin\/)?sh -c ps -A|^ps -A|^\(.*\)$/;

/** Executable basename and its operands; long options are dropped unless they are all there is. */
export function briefCommand(args: string) {
  const [exe = '', ...rest] = args.trim().split(/\s+/);
  const operands = rest.filter(part => !part.startsWith('--'));
  return [basename(exe), ...(operands.length ? operands : rest)].join(' ').slice(0, 160);
}

const seconds = (value: string) => /^\d+$/.test(value) ? Number(value)
  : value.split(/[-:]/).reverse().reduce((sum, part, index) => sum + Number(part) * [1, 60, 3600, 86400][index]!, 0);
const ageBucket = (value: number) => value < 10 ? 0 : value < 60 ? 10 : value < 300 ? 60 : 300;
const silenceBucket = (value: number) => [60, 30, 15, 8, 4, 0].find(bound => value >= bound) ?? 0;

/** An htop-like view of processes descended from the harness. */
export class ProcessTable {
  private history = new Map<number, { rssMb: number; at: number }>();
  private lastCommands = new Map<number, string>();
  /** Peak RSS and lifetime per live pid, and of the last ended instance per command. */
  private peaks = new Map<number, { command: string; rssMb: number; seconds: number }>();
  private previous = new Map<string, { rssMb: number; seconds: number }>();
  constructor(private context: MonitorContext) {}

  async rows(): Promise<Row[]> {
    // `etime` ([[dd-]hh:]mm:ss) is portable across Linux and macOS; `etimes` is not.
    const table = await this.context.run('ps -A -o pid=,ppid=,pcpu=,rss=,etime=,args=', { timeoutMs: 5000, maxOutput: 2_000_000 });
    return table.output.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
      .map(match => ({ pid: Number(match![1]), ppid: Number(match![2]), cpu: Number(match![3]), rssMb: Math.round(Number(match![4]) / 1024),
        seconds: seconds(match![5]!), command: briefCommand(match![6]!), args: match![6]! }));
  }

  private static descendants(rows: Row[], root: number) {
    const set = new Set([root]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows) if (set.has(row.ppid) && !set.has(row.pid)) { set.add(row.pid); changed = true; }
    }
    return set;
  }

  /** One row, with RSS change since a baseline sample (a memory trend, like htop's graph). */
  private describe(row: Row, now: number) {
    const first = this.history.get(row.pid);
    // Every process allocates while it starts; the baseline is the first sample after 5 s of age.
    if (!first && row.seconds >= 5) this.history.set(row.pid, { rssMb: row.rssMb, at: now });
    const trend = first && Math.abs(row.rssMb - first.rssMb) >= 32
      ? ` (${row.rssMb > first.rssMb ? '+' : ''}${row.rssMb - first.rssMb}MB in the last ${Math.round((now - first.at) / 1000)}s)` : '';
    // A young process replacing an earlier instance of the same command: compare with it,
    // and say whether it started right after the executive's edit (a reload) or not.
    const before = row.seconds < 60 ? this.previous.get(row.command) : undefined;
    const editAgo = this.context.lastEditAt() ? (now - this.context.lastEditAt()) / 1000 : Infinity;
    const cause = editAgo - row.seconds >= -1 && editAgo - row.seconds <= 5 ? `restarted ${Math.max(0, Math.round(editAgo - row.seconds))}s after the executive's last edit` : 'restarted';
    const restarted = before ? ` (${cause}; the previous instance peaked at ${before.rssMb}MB over ${before.seconds}s)` : '';
    return `${row.pid} cpu=${row.cpu.toFixed(0)}% rss=${row.rssMb}MB${trend}${restarted} age=${row.seconds}s ${row.command}`;
  }

  private trackPeaks(shown: Row[]) {
    const live = new Set(shown.map(row => row.pid));
    for (const [pid, peak] of this.peaks) if (!live.has(pid)) { this.previous.set(peak.command, { rssMb: peak.rssMb, seconds: peak.seconds }); this.peaks.delete(pid); }
    for (const row of shown) {
      const peak = this.peaks.get(row.pid);
      this.peaks.set(row.pid, { command: row.command, rssMb: Math.max(peak?.rssMb ?? 0, row.rssMb), seconds: row.seconds });
    }
  }

  /** Background processes, excluding the executive's blocked call (the blocking sensor covers it). */
  async sample(exclude?: number): Promise<Observation | undefined> {
    const rows = await this.rows();
    const mine = ProcessTable.descendants(rows, process.pid);
    const skip = exclude ? ProcessTable.descendants(rows, exclude) : new Set<number>();
    const now = Date.now();
    // Hide harness runtime subtrees below the harness process (which itself runs under tsx).
    const harness = new Set<number>();
    for (const row of rows) if (row.pid !== process.pid && mine.has(row.pid) && harnessProcess.test(row.args)) for (const pid of ProcessTable.descendants(rows, row.pid)) harness.add(pid);
    const shown = rows.filter(row => row.pid !== process.pid && mine.has(row.pid) && !skip.has(row.pid) && !harness.has(row.pid));
    // An exited pid replaced by a new instance of the same command is reported as a restart on the new row.
    const replaced = (command: string) => shown.some(row => row.command === command && !this.lastCommands.has(row.pid));
    const editAgo = this.context.lastEditAt() ? Math.round((now - this.context.lastEditAt()) / 1000) : undefined;
    const gone = [...this.lastCommands].filter(([pid, command]) => !shown.some(row => row.pid === pid) && !replaced(command))
      .map(([pid, command]) => `${pid} ${command}${editAgo !== undefined && editAgo <= 8 ? ` (the executive edited files ${editAgo}s ago; supervisors restart on edits)` : ''}`);
    this.lastCommands = new Map(shown.map(row => [row.pid, row.command]));
    this.trackPeaks(shown);
    if (!shown.length && !gone.length) return undefined;
    const content = [...shown.map(row => this.describe(row, now)), ...(gone.length ? [`exited since the previous look: ${gone.join('; ')}`] : [])].join('\n');
    const coarse = shown.map(row => ({ command: row.command, cpu: Math.round(row.cpu / 50) * 50, rssMb: Math.round(row.rssMb / 64) * 64, ageBucket: ageBucket(row.seconds) }))
      .sort((a, b) => a.command.localeCompare(b.command));
    return { stream: 'processes', source: 'processes', editRevision: this.context.editRevision(), content,
      facts: { processes: coarse }, noveltyKey: JSON.stringify(coarse) };
  }

  /** Durations of earlier calls of the same command that finished on their own. */
  private completed = new Map<string, number[]>();
  recordCompletion(command: string, seconds: number) {
    const list = this.completed.get(command) ?? [];
    list.push(Math.round(seconds * 10) / 10);
    this.completed.set(command, list.slice(-5));
  }

  /**
   * The executive's blocked call: elapsed time, silence, its process subtree, output tail,
   * and how long earlier runs of the same command took. Ordinary code states the plain
   * facts (spinning, idle, growing); System 1 judges what they mean for this task.
   */
  async blocking(call: BlockingCall): Promise<Observation | undefined> {
    const pid = call.pid();
    const rows = pid ? await this.rows() : [];
    const tree = pid ? ProcessTable.descendants(rows, pid) : new Set<number>();
    const subtree = rows.filter(row => tree.has(row.pid));
    const now = Date.now();
    const elapsed = Math.round((now - call.startedAt) / 1000);
    const silent = Math.round((now - call.lastOutputAt()) / 1000);
    const cpu = Math.max(0, ...subtree.map(row => row.cpu));
    const rssMb = subtree.reduce((sum, row) => sum + row.rssMb, 0);
    const busy = subtree.filter(row => row.cpu >= 80);
    const state = silent < 5 ? 'producing output' : busy.length ? 'spinning' : subtree.every(row => row.cpu <= 5) ? 'idle' : 'quiet';
    // When output exists: how long it took to produce all of it (a spinner that stopped moving).
    const produced = call.output().trim() ? `; all output so far arrived within the first ${Math.max(0.1, (call.lastOutputAt() - call.startedAt) / 1000).toFixed(1)}s` : '';
    const stateLine = state === 'spinning' ? `spinning: ${busy.map(row => `${row.command} at ${row.cpu.toFixed(0)}% CPU`).join(', ')}; no output for ${silent}s${produced}`
      : state === 'idle' ? `idle: every process near 0% CPU and no output for ${silent}s${produced}` : state === 'quiet' ? `quiet: no output for ${silent}s${produced}` : `producing output (last ${silent}s ago)`;
    const earlier = this.completed.get(call.command) ?? [];
    const tail = call.output().split('\n').slice(-30).join('\n');
    const content = [
      `The executive is blocked on ${call.name}: $ ${call.command}`,
      `running for ${elapsed}s; ${call.output() ? `last output ${silent}s ago` : `no output at all yet`}`,
      `state: ${stateLine}`,
      earlier.length ? `earlier runs of this command finished in: ${earlier.map(value => `${value}s`).join(', ')}` : 'no earlier completed run of this command in this session',
      'process subtree:', ...subtree.map(row => `  ${this.describe(row, now)}`),
      'output tail:', ...(tail.trim() ? tail.split('\n').map(line => `  ${line.slice(0, 300)}`) : ['  (none)']),
    ].join('\n');
    return { stream: `blocking:${call.name}`, source: 'blocking', editRevision: call.editRevision, interruptible: true, content,
      facts: { elapsedSeconds: elapsed, silentSeconds: silent, state, cpu: Math.round(cpu), rssMb, processes: subtree.length,
        ...(earlier.length ? { earlierRunsSeconds: earlier } : {}) },
      noveltyKey: JSON.stringify({ elapsed: silenceBucket(elapsed), silent: silenceBucket(silent), state,
        rss: Math.round(rssMb / 128), output: digest(tail.slice(-2000)), processes: subtree.map(row => row.command).sort() }) };
  }
}
