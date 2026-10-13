// Offline next-action prediction benchmark. Replays recorded executive trajectories
// against base-commit checkouts: after each executive view (read_file / search) that
// precedes its first edit, ordinary-code affordances propose candidate next views and
// each predictor says what the executive does next. Labels are what the executive
// actually did in its next actions. No executive or Modal calls; only System 1.
//
//   npx tsx evals/nap-bench.ts --instances dev-instances.json --runs .ros/evals/RUN1,.ros/evals/RUN2 [--predictors lexical,dive,anticipate]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadModelEnvironment } from '../src/auth.js';
import { actions, anticipationChooser, type ActionKind } from '../src/anticipation.js';
import { lexicalChooser, system1Chooser, type Candidate, type Chooser } from '../src/attention.js';
import type { Answer, MonitorContext, ToolEvent } from '../src/monitor.js';
import { CodeIndex, codeAffordances, describe, executiveView, SeenRanges } from '../src/monitors/dives.js';
import { defaultSystem1Model } from '../src/models.js';
import { jevEvaluate } from '../src/system1.js';
import { Workspace } from '../src/workspace.js';

const { values } = parseArgs({ options: {
  instances: { type: 'string' }, runs: { type: 'string', default: '' }, profile: { type: 'string', default: 'executive-only' },
  predictors: { type: 'string', default: 'lexical,dive,anticipate' }, horizon: { type: 'string', default: '3' }, candidates: { type: 'string', default: '8' },
  concurrency: { type: 'string', default: '6' }, label: { type: 'string', default: 'nap' }, limit: { type: 'string' },
} });
loadModelEnvironment();
const horizon = Number(values.horizon);
const workspaces = new Map((JSON.parse(await readFile(values.instances!, 'utf8')) as Array<{ instance_id: string; workspace: string }>).map(item => [item.instance_id, item.workspace]));
const evaluate = jevEvaluate(process.env.ROS_SYSTEM1_MODEL || defaultSystem1Model);
let spend = 0, calls = 0;
const context: Pick<MonitorContext, 'evaluate'> = {
  async evaluate(_purpose, state, questions) {
    const result = await evaluate(state, questions, AbortSignal.timeout(30_000));
    calls++; spend += result.costUsd ?? 0;
    return result.answers as Record<string, Answer>;
  },
};
const predictors: Record<string, Chooser> = { lexical: lexicalChooser, dive: system1Chooser(context), anticipate: anticipationChooser(context) };
const chosen = values.predictors!.split(',');

type Step = { name: string; input: Record<string, unknown>; output: unknown; edit?: { line: number } };
type Trial = { run: string; repeat: string; instance: string; task: string; steps: Step[] };

function trials(): Trial[] {
  const found: Trial[] = [];
  for (const run of values.runs!.split(',').filter(Boolean)) {
    const base = resolve(run, values.profile!);
    if (!existsSync(base)) continue;
    for (const repeat of readdirSync(base)) for (const instance of readdirSync(resolve(base, repeat))) {
      const file = resolve(base, repeat, instance, 'events.jsonl');
      if (!existsSync(file) || !workspaces.has(instance)) continue;
      found.push({ run, repeat, instance, task: '', steps: [] });
    }
  }
  return found;
}

async function load(trial: Trial) {
  const events = (await readFile(resolve(trial.run, values.profile!, trial.repeat, trial.instance, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  trial.task = events.find(event => event.lane === 'executive' && event.kind === 'prompt')?.message ?? '';
  let pending: { name: string; input: Record<string, unknown> } | undefined;
  for (const event of events) {
    if (event.lane === 'executive' && event.kind === 'tool') {
      const data = event.data ?? {};
      pending = { name: data.toolName, input: { ...(data.input ?? {}), ...(data.path ? { path: data.path } : {}), ...(data.query ? { query: data.query } : {}) } };
    } else if (event.lane === 'environment' && event.kind === 'result' && pending) {
      trial.steps.push({ ...pending, output: event.data?.output, edit: event.data?.edit });
      pending = undefined;
    }
  }
}

// Candidate labels read "path lines a-b (...)".
const range = (label: string) => { const match = /^(\S+) lines (\d+)-(\d+)/.exec(label); return match ? { path: match[1]!, start: Number(match[2]), end: Number(match[3]) } : undefined; };
const kindOf = (step: Step | undefined): ActionKind => !step ? 'finish' : step.name === 'read_file' ? 'view' : step.name === 'search' || step.name === 'list_files' ? 'search'
  : step.name === 'replace_text' || step.name === 'write_file' ? 'edit' : step.name === 'run_checks' ? 'verify' : 'search';

/** Does the candidate cover where the executive looked or edited in its next `limit` actions? */
function hit(candidate: Candidate, future: Step[], limit: number) {
  const target = range(candidate.label);
  if (!target) return false;
  return future.slice(0, limit).some(step => {
    const path = String(step.input.path ?? (step.output as { path?: string } | undefined)?.path ?? '');
    if (path !== target.path) return false;
    if (step.name === 'read_file') {
      const output = step.output as { startLine?: number; endLine?: number };
      return Number(output?.startLine) <= target.end && Number(output?.endLine) >= target.start;
    }
    if ((step.name === 'replace_text' || step.name === 'write_file') && step.edit) return step.edit.line >= target.start && step.edit.line <= target.end;
    return false;
  });
}

const rows: Array<Record<string, unknown>> = [];
const indexes = new Map<string, Promise<CodeIndex>>();
async function score(trial: Trial) {
  await load(trial);
  const workspace = new Workspace(workspaces.get(trial.instance)!);
  if (!indexes.has(trial.instance)) indexes.set(trial.instance, (async () => { const index = new CodeIndex(workspace); await index.ensure(); return index; })());
  const index = await indexes.get(trial.instance)!;
  const seen = new SeenRanges();
  const affordances = codeAffordances(index, seen, { task: () => trial.task, read: async path => workspace.read(path) },
    { viewLines: 60, minViewLines: 1, previewLines: 24, tests: true });
  const recent: string[] = [];
  for (let at = 0; at < trial.steps.length; at++) {
    const step = trial.steps[at]!;
    // Only views of base-commit code: after the first edit the checkout no longer matches.
    if (step.name === 'replace_text' || step.name === 'write_file') break;
    const event: ToolEvent = { name: step.name, input: step.input, output: step.output, editRevision: 0, edited: [] };
    const output = step.output as { path?: string; hash?: string; startLine?: number; endLine?: number } | undefined;
    if (step.name === 'read_file' && output?.path && output.hash) seen.add(output.path, output.hash, Number(output.startLine), Number(output.endLine));
    recent.push(describe(event));
    const view = executiveView(event);
    if (!view) continue;
    const candidates = (await affordances.candidates([view], new Set([view.key]))).slice(0, Number(values.candidates));
    const future = trial.steps.slice(at + 1);
    const row: Record<string, unknown> = { run: trial.run.split('/').at(-1), repeat: trial.repeat, instance: trial.instance, at, trigger: step.name,
      nextKind: kindOf(future[0]), candidates: candidates.length,
      hitsNext: candidates.map(candidate => hit(candidate, future, 1)), hitsHorizon: candidates.map(candidate => hit(candidate, future, horizon)) };
    for (const name of chosen) {
      const predictor = predictors[name]!;
      if (!candidates.length && name !== 'anticipate') continue;
      try {
        const input = { task: trial.task, recent: [...recent.slice(0, -1), `${recent.at(-1)} (latest; the current view)`], views: [view], trajectory: [], candidates, hop: 1, perHop: 1, criteria: affordances.criteria };
        const choice = await predictor.choose(input);
        row[name] = { follow: choice.follow, probabilities: choice.probabilities, ...('next' in choice ? { next: (choice as { next: unknown }).next } : {}) };
      } catch (error) { row[name] = { error: error instanceof Error ? error.message : String(error) }; }
    }
    rows.push(row);
  }
}

let all = trials();
if (values.limit) all = all.slice(0, Number(values.limit));
const queue = [...all];
await Promise.all(Array.from({ length: Number(values.concurrency) }, async () => { for (let item = queue.shift(); item; item = queue.shift()) await score(item); }));

// Summaries: delivering the top candidate when follow >= f and P(top) >= t.
type Prediction = { follow: number; probabilities: number[]; next?: Record<ActionKind, number> };
function deliver(row: Record<string, unknown>, name: string, follow: number, threshold: number) {
  const prediction = row[name] as Prediction | undefined;
  if (!prediction || 'error' in (prediction as object) || !prediction.probabilities?.length) return undefined;
  if (prediction.follow < follow) return undefined;
  let best = 0;
  prediction.probabilities.forEach((probability, index) => { if (probability > prediction.probabilities[best]!) best = index; });
  return prediction.probabilities[best]! >= threshold ? best : undefined;
}
const report: string[] = [`# Next-action prediction (${values.label})`, '', `${all.length} trajectories, ${rows.length} decision points, horizon ${horizon}. System 1 spend $${spend.toFixed(4)} over ${calls} calls.`, ''];
const anyNext = rows.filter(row => (row.hitsNext as boolean[]).some(Boolean)).length / rows.length;
const anyHorizon = rows.filter(row => (row.hitsHorizon as boolean[]).some(Boolean)).length / rows.length;
report.push(`Candidate recall (some candidate is the next view): next action ${(100 * anyNext).toFixed(1)}%, within ${horizon} actions ${(100 * anyHorizon).toFixed(1)}%.`, '');
report.push('| Predictor | follow ≥ | P ≥ | Delivered | Precision (next) | Precision (≤ horizon) | Yield (≤ horizon) per view |', '| --- | --- | --- | --- | --- | --- | --- |');
for (const name of chosen) {
  const grid = name === 'lexical' ? [[0, 0]] : [[0, 0], [0.5, 0.5], [0.5, 0.7], [0.7, 0.7], [0.3, 0.8], [0.5, 0.85], [0.7, 0.9]];
  for (const [follow, threshold] of grid) {
    const picks = rows.map(row => ({ row, index: deliver(row, name, follow!, threshold!) })).filter(item => item.index !== undefined);
    const nextHits = picks.filter(item => (item.row.hitsNext as boolean[])[item.index!]).length;
    const horizonHits = picks.filter(item => (item.row.hitsHorizon as boolean[])[item.index!]).length;
    report.push(`| ${name} | ${follow} | ${threshold} | ${(100 * picks.length / rows.length).toFixed(1)}% | ${picks.length ? (100 * nextHits / picks.length).toFixed(1) : '-'}% | ${picks.length ? (100 * horizonHits / picks.length).toFixed(1) : '-'}% | ${(horizonHits / rows.length).toFixed(3)} |`);
  }
}
if (chosen.includes('anticipate')) {
  const scored = rows.filter(row => (row.anticipate as Prediction | undefined)?.next);
  const correct = scored.filter(row => { const next = (row.anticipate as Prediction).next!; return (Object.keys(next) as ActionKind[]).reduce((a, b) => next[a] >= next[b] ? a : b) === row.nextKind; }).length;
  const base = Object.fromEntries(Object.keys(actions).map(kind => [kind, rows.filter(row => row.nextKind === kind).length]));
  report.push('', `Next action kind: System 1 accuracy ${(100 * correct / Math.max(1, scored.length)).toFixed(1)}% over ${scored.length} points; label distribution ${JSON.stringify(base)}.`);
}
const directory = resolve('.ros/nap');
await mkdir(directory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '');
await writeFile(resolve(directory, `${stamp}-${values.label}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
await writeFile(resolve(directory, `${stamp}-${values.label}.md`), report.join('\n') + '\n');
console.log(report.join('\n'));
