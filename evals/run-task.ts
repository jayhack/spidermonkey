import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadModelEnvironment } from '../src/auth.js';
import { startBridge } from '../src/bridge.js';
import { Controller } from '../src/controller.js';
import { startExecutive } from '../src/executive.js';
import { defaultExecutiveModel, defaultSystem1Model } from '../src/models.js';
import { jevClassifier } from '../src/system1.js';
import { jevScorer, type Scorer } from '../src/localize.js';
import { jevEvaluate } from '../src/system1.js';
import type { S1Evaluate } from '../src/monitor.js';
import { startServices, type ServiceSpec } from '../src/services.js';
import { tuningSchema } from '../src/tuning.js';
import type { DashboardState, HarnessEvent } from '../src/types.js';
import { Workspace } from '../src/workspace.js';

// Receives only the problem statement and a developer-visible check command.
// Gold patches, test patches, and grading scripts never enter this process.
// Optional background services (dev servers, workers) run for the whole attempt.
// A `script` replaces the Eve executive with a fixed list of tool calls: no executive
// model runs, and metrics are labeled `scripted`. It exercises sensors, System 1 and
// graders cheaply; it is never reported as a live executive result.
type ScriptStep = { tool: string; input?: Record<string, unknown> } | { waitMs: number } | { answer: string };
const input = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as {
  task: string; workspace: string; output: string; check: string;
  tuning: unknown; timeoutSeconds: number; maxSteps: number; maxCostUsd: number;
  checkTimeoutSeconds?: number; services?: ServiceSpec[]; servicesWarmupMs?: number; script?: ScriptStep[];
  /** Directory Eve runs in; concurrent attempts need separate `.eve/` state. Defaults to the cwd. */
  projectRoot?: string;
};
loadModelEnvironment();
const tuning = tuningSchema.parse(input.tuning);
await mkdir(input.output, { recursive: true });
const events: HarnessEvent[] = [];
let traceTail = Promise.resolve();
let attemptedSystem1Calls = 0;
const state: DashboardState = {
  mode: input.script ? 'SCRIPTED EVAL' : 'LIVE EVAL', task: input.task, workspace: input.workspace, status: 'Starting',
  executiveModel: input.script ? 'scripted (no model)' : process.env.ROS_EXECUTIVE_MODEL || defaultExecutiveModel,
  system1Model: process.env.ROS_SYSTEM1_MODEL || defaultSystem1Model,
  hz: tuning.hz, frames: 0, skipped: 0, reflexes: 0, escalations: 0,
  inputTokens: 0, lastLatencyMs: 0, probabilities: {}, events: [], answer: '',
};
const classify = jevClassifier(state.system1Model, tuning);
const score = jevScorer(state.system1Model, tuning.localize?.previewLines);
// Count localization requests too, so incomplete System 1 inference is never free.
const scorer: Scorer = {
  files: (task, files, signal) => { attemptedSystem1Calls++; return score.files(task, files, signal); },
  chunks: (task, chunks, signal) => { attemptedSystem1Calls++; return score.chunks(task, chunks, signal); },
};
const evaluateS1 = jevEvaluate(state.system1Model);
const s1: S1Evaluate = (s1State, questions, signal) => { attemptedSystem1Calls++; return evaluateS1(s1State, questions, signal); };
const controller = new Controller(new Workspace(input.workspace, input.check, (input.checkTimeoutSeconds ?? 120) * 1000), state,
  async (snapshot, signal) => {
    attemptedSystem1Calls++;
    traceTail = traceTail.then(() => appendFile(resolve(input.output, 'snapshots.jsonl'), JSON.stringify(snapshot) + '\n', { mode: 0o600 }));
    return classify(snapshot, signal);
  }, event => {
    events.push(event);
    traceTail = traceTail.then(() => appendFile(resolve(input.output, 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 }));
    if (event.kind !== 'message_delta') console.log(`[${event.lane}/${event.kind}] ${event.message.slice(0, 200)}`);
  }, tuning.threshold, tuning, scorer, s1);
async function runScript(script: ScriptStep[]) {
  controller.beginTurn(input.task);
  await controller.prime();
  let answer = '';
  for (const step of script) {
    abort.signal.throwIfAborted();
    if ('waitMs' in step) await new Promise(resolve => setTimeout(resolve, step.waitMs));
    else if ('tool' in step) {
      controller.emit('executive', 'step', 'Scripted step (no model call)', { scripted: true });
      await controller.tool(step.tool, step.input ?? {});
    } else {
      answer = step.answer;
      controller.emit('executive', 'message', answer, { scripted: true });
      const followUp = await controller.finalGate(answer);
      if (followUp) controller.emit('executive', 'prompt', followUp, { source: 'system1-final-gate' });
    }
  }
  return answer;
}

const abort = new AbortController();
const interrupt = () => abort.abort(new Error('Eval interrupted'));
process.once('SIGTERM', interrupt);
process.once('SIGINT', interrupt);
let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
let executive: Awaited<ReturnType<typeof startExecutive>> | undefined;
let services: Awaited<ReturnType<typeof startServices>> | undefined;
let error: string | undefined;
let started = 0;
let elapsedSeconds = 0;
const boot = performance.now();
let bootSeconds = 0;
try {
  if (!input.script) {
    bridge = await startBridge(controller);
    executive = await startExecutive(controller, bridge, resolve(input.output, 'eve.log'), {
      projectRoot: input.projectRoot, signal: abort.signal, timeoutMs: input.timeoutSeconds * 1000,
      maxSteps: input.maxSteps, maxCostUsd: input.maxCostUsd, followUps: tuning.followUps,
    });
  }
  bootSeconds = (performance.now() - boot) / 1000;
  if (input.services?.length) {
    services = await startServices(input.workspace, input.services, event =>
      controller.emit('environment', 'service', `${event.name} ${event.kind}${event.kind === 'exited' ? ` (code ${event.code ?? 'none'}, signal ${event.signal ?? 'none'})` : ''}`, { ...event }));
    await new Promise(resolve => setTimeout(resolve, input.servicesWarmupMs ?? 1500));
  }
  started = performance.now();
  // No System 1 calls during the dev server's cold start.
  controller.start();
  if (executive) state.answer = await executive.run(input.task);
  else state.answer = await runScript(input.script ?? []);
} catch (cause) {
  error = cause instanceof Error ? cause.message : String(cause);
} finally {
  elapsedSeconds = started ? (performance.now() - started) / 1000 : 0;
  await controller.stop();
  await executive?.stop();
  await services?.stop();
  await bridge?.close();
  await traceTail;
}
const executiveUsage = events.filter(event => event.kind === 'usage' && event.lane === 'executive')
  .map(event => event.data?.usage as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; costUsd?: number } | undefined);
const system1Usage = events.filter(event => event.kind === 'usage' && event.lane === 'system1');
// Steps and cost per executive model, for runs where System 1 routes between models.
const byModel: Record<string, { steps: number; costUsd: number; inputTokens: number; outputTokens: number }> = {};
let currentModel = 'unknown';
for (const event of events.filter(item => item.lane === 'executive' && (item.kind === 'step' || item.kind === 'usage'))) {
  if (event.kind === 'step') { currentModel = String(event.data?.model ?? 'unknown'); (byModel[currentModel] ??= { steps: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 }).steps++; continue; }
  const usage = event.data?.usage as { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined;
  const entry = byModel[currentModel] ??= { steps: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  entry.costUsd += usage?.costUsd ?? 0; entry.inputTokens += usage?.inputTokens ?? 0; entry.outputTokens += usage?.outputTokens ?? 0;
}
// Missing provider costs are unknown, never interpreted as free inference.
const completeCost = (values: Array<number | undefined>) => values.every(value => value !== undefined)
  ? values.reduce<number>((sum, value) => sum + value!, 0) : null;
const metrics = {
  mode: input.script ? 'scripted' : 'live', executiveModel: state.executiveModel, system1Model: state.system1Model,
  tuning, status: error ? 'harness_error' : 'completed', error, answer: state.answer,
  elapsedSeconds, bootSeconds,
  executive: { steps: events.filter(event => event.kind === 'step' && event.lane === 'executive').length,
    completedSteps: executiveUsage.length,
    inputTokens: executiveUsage.reduce((sum, usage) => sum + (usage?.inputTokens ?? 0), 0),
    outputTokens: executiveUsage.reduce((sum, usage) => sum + (usage?.outputTokens ?? 0), 0),
    cacheReadTokens: executiveUsage.reduce((sum, usage) => sum + (usage?.cacheReadTokens ?? 0), 0),
    byModel,
    costUsd: executiveUsage.length === events.filter(event => event.kind === 'step' && event.lane === 'executive').length
      ? completeCost(executiveUsage.map(usage => usage?.costUsd)) : null },
  system1: { calls: state.frames, attemptedCalls: attemptedSystem1Calls, inputTokens: state.inputTokens, reflexes: state.reflexes,
    escalations: state.escalations, skipped: state.skipped,
    latencyMs: system1Usage.reduce((sum, event) => sum + Number(event.data?.latencyMs ?? 0), 0),
    costUsd: attemptedSystem1Calls !== state.frames || events.some(event => event.lane === 'system1' && event.kind === 'error') ? null
      : completeCost(system1Usage.map(event => event.data?.costUsd as number | undefined)),
    errors: events.filter(event => event.lane === 'system1' && event.kind === 'error').map(event => event.message) },
  tools: events.filter(event => event.lane === 'executive' && event.kind === 'tool').map(event => event.data?.toolName),
  lastCheck: controller.board().lastCheck,
  perception: {
    findings: events.filter(event => event.lane === 'system1' && (event.kind === 'finding' || event.kind === 'escalation') && event.data?.key).length,
    interrupts: events.filter(event => event.lane === 'system1' && event.kind === 'interrupt').length,
    followUps: events.filter(event => event.lane === 'executive' && event.kind === 'prompt' && event.data?.source === 'system1-final-gate').length,
  },
};
await writeFile(resolve(input.output, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n', { mode: 0o600 });
if (error) process.exitCode = 1;
