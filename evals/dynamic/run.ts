import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startServices } from '../../src/services.js';
import type { HarnessEvent } from '../../src/types.js';
import { Workspace } from '../../src/workspace.js';
import {
  analyze, collectWorld, grade, loadSuite, loadTasks, materialize, overlayScript, privateProject, repoRoot, root, run, taskText, timedLines,
  type AttemptResult, type Suite, type TaskSpec,
} from './lib.js';
import { report } from './report.js';

// Dynamic-world driver. Runs the real controller and Eve executive (evals/run-task.ts)
// against generated repositories whose environment changes while the executive works.
//
//   tsx evals/dynamic/run.ts --calibrate                       graders and world dynamics, no models
//   tsx evals/dynamic/run.ts --scripted naive --arms perception   scripted executive, live Jev
//   tsx evals/dynamic/run.ts --repeats 3 --concurrency 4       live Luna executive, all arms
//   tsx evals/dynamic/run.ts --holdout --repeats 3             the held-out tasks instead
//   tsx evals/dynamic/run.ts --report DIR                      rebuild report.md from results.jsonl
//
// Traces go to <out>/dynamic-<name>/ (default <repo>/.ros/evals), which is Git-ignored.

const { values } = parseArgs({ options: {
  tasks: { type: 'string' }, arms: { type: 'string' }, repeats: { type: 'string', default: '1' },
  concurrency: { type: 'string', default: '3' }, name: { type: 'string' }, out: { type: 'string' },
  budget: { type: 'string', default: '5' }, calibrate: { type: 'boolean', default: false },
  scripted: { type: 'string' }, report: { type: 'string' }, keep: { type: 'boolean', default: false },
  holdout: { type: 'boolean', default: false },
} });

if (values.report) {
  const dir = resolve(values.report);
  const results = (await readFile(join(dir, 'results.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as AttemptResult);
  const saved = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { tasks: string[] };
  await writeFile(join(dir, 'report.md'), report(results, await loadTasks(saved.tasks), saved));
  console.log(`Wrote ${join(dir, 'report.md')}`);
  process.exit(0);
}

const suite = await loadSuite();
const tasks = await loadTasks(values.tasks?.split(','), { heldOut: values.holdout });
const outBase = resolve(values.out ?? join(repoRoot, '.ros/evals'));
const name = values.name ?? new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');

if (values.calibrate) {
  const dir = join(outBase, `dynamic-calibration-${name}`);
  await mkdir(dir, { recursive: true });
  const rows = await Promise.all(tasks.map(task => calibrate(task)));
  await writeFile(join(dir, 'calibration.json'), `${JSON.stringify(rows, null, 2)}\n`);
  for (const row of rows) console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.task}: ${row.notes.join('; ')}`);
  console.log(`Wrote ${join(dir, 'calibration.json')}`);
  process.exit(rows.every(row => row.ok) ? 0 : 1);
}

const armNames = values.arms?.split(',') ?? Object.keys(suite.arms);
for (const arm of armNames) if (!suite.arms[arm]) throw new Error(`Unknown arm ${arm}`);
const repeats = Number(values.repeats);
const scripted = values.scripted as 'naive' | 'reference' | undefined;
const dir = join(outBase, `dynamic-${scripted ? `scripted-${scripted}-` : ''}${name}`);
await mkdir(dir, { recursive: true });
const manifest = {
  name, createdAt: new Date().toISOString(), mode: scripted ? `scripted:${scripted}` : 'live',
  executiveModel: scripted ? 'scripted (no model)' : suite.executiveModel, executiveReasoning: suite.executiveReasoning,
  system1Model: process.env.ROS_SYSTEM1_MODEL || 'typesafe-ai/jev', tasks: tasks.map(task => task.id), arms: armNames, repeats, suite,
};
await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// Interleave: each repeat rotates arm order so no arm always runs first or under the same load.
const jobs: Array<{ task: TaskSpec; arm: string; repeat: number }> = [];
for (let repeat = 1; repeat <= repeats; repeat++) {
  for (const task of tasks) {
    const rotated = armNames.map((_, index) => armNames[(index + repeat - 1 + tasks.indexOf(task)) % armNames.length]!);
    for (const arm of rotated) {
      if (suite.arms[arm]!.servicesOnly && !task.services.length) continue;
      jobs.push({ task, arm, repeat });
    }
  }
}
console.log(`${jobs.length} attempts → ${dir}`);

const budget = Number(values.budget);
let spent = 0;
let stopped = false;
const results: AttemptResult[] = [];
let next = 0;
const worker = async () => {
  while (next < jobs.length && !stopped) {
    const job = jobs[next++]!;
    const result = await attempt(job.task, job.arm, job.repeat).catch(error => {
      console.error(`${job.task.id}/${job.arm}/r${job.repeat} failed: ${error instanceof Error ? error.stack : String(error)}`);
      return undefined;
    });
    if (!result) continue;
    results.push(result);
    spent += (result.executiveCostUsd ?? 0) + (result.jevCostUsd ?? 0);
    await writeFile(join(dir, 'results.jsonl'), results.map(item => JSON.stringify(item)).join('\n') + '\n');
    console.log(`[${results.length}/${jobs.length}] ${job.task.id}/${job.arm}/r${job.repeat}: ${result.success ? 'PASS' : 'fail'} ${result.elapsedSeconds.toFixed(0)}s steps=${result.executiveSteps} `
      + `jev=${result.jevCalls} blocked=${result.blockedSeconds}s interrupts=${result.interrupts} followUps=${result.followUps} delivered=${result.delivered} $${spent.toFixed(3)} total`);
    if (spent >= budget) { stopped = true; console.error(`Budget of $${budget} reached; stopping after in-flight attempts.`); }
  }
};
await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
await writeFile(join(dir, 'report.md'), report(results, tasks, manifest));
console.log(`Wrote ${join(dir, 'report.md')} ($${spent.toFixed(3)} model spend)`);

/**
 * One attempt. An infrastructure failure before the executive's first model step (Eve never
 * started a step) is retried once with a fresh workspace, for every arm alike, and recorded.
 */
async function attempt(task: TaskSpec, arm: string, repeat: number): Promise<AttemptResult> {
  let result = await attemptOnce(task, arm, repeat);
  if (!scripted && result.status === 'harness_error' && result.executiveSteps === 0) {
    console.error(`${task.id}/${arm}/r${repeat}: executive never started (${result.error}); retrying once`);
    result = { ...await attemptOnce(task, arm, repeat), retried: true };
  }
  return result;
}

async function attemptOnce(task: TaskSpec, arm: string, repeat: number): Promise<AttemptResult> {
  const config = suite.arms[arm]!;
  const output = join(dir, task.id, arm, `r${repeat}`);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const workspace = await materialize(task);
  const project = scripted ? undefined : await privateProject();
  try {
    const tuning = JSON.parse(await readFile(join(root, 'profiles', config.profile), 'utf8'));
    if (config.appraiser) tuning.monitors.perception.appraiser = config.appraiser;
    const request = {
      task: taskText(task, suite, Boolean(config.poll)), workspace, output, check: task.check, tuning,
      timeoutSeconds: suite.timeoutSeconds, maxSteps: suite.maxSteps, maxCostUsd: suite.maxCostUsd,
      checkTimeoutSeconds: suite.checkTimeoutSeconds, services: task.services, servicesWarmupMs: suite.servicesWarmupMs,
      ...(project ? { projectRoot: project } : {}),
      // Scripted pacing mimics an executive: look around first, edit, write a test, then check.
      ...(scripted ? { script: [{ waitMs: 8000 }, ...await overlayScript(task, scripted, workspace), { waitMs: 6000 }, { tool: 'run_checks' }, { answer: 'Done.' }] } : {}),
    };
    await writeFile(join(output, 'request.json'), `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
    await run(process.execPath, [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), join(repoRoot, 'evals/run-task.ts'), join(output, 'request.json')], {
      cwd: repoRoot, timeoutMs: (suite.timeoutSeconds + 180) * 1000, log: join(output, 'harness.log'),
      env: { ...process.env, ROS_EXECUTIVE_MODEL: suite.executiveModel, ROS_EXECUTIVE_REASONING: suite.executiveReasoning },
    });
    const events = (await readFile(join(output, 'events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as HarnessEvent);
    const metrics = JSON.parse(await readFile(join(output, 'metrics.json'), 'utf8').catch(() => '{"status":"missing"}'));
    const world = await collectWorld(workspace);
    await mkdir(join(output, 'world'), { recursive: true });
    for (const [path, text] of Object.entries(world)) await writeFile(join(output, 'world', path.replaceAll('/', '__')), text);
    const graded = await grade(task, workspace);
    await writeFile(join(output, 'grade.json'), `${JSON.stringify(graded, null, 2)}\n`);
    const result = analyze(task, arm, repeat, events, world, metrics, graded);
    await writeFile(join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    if (values.keep) await cp(workspace, join(output, 'workspace'), { recursive: true });
    return result;
  } finally {
    await rm(workspace, { recursive: true, force: true });
    if (project) await rm(project, { recursive: true, force: true });
  }
}

/**
 * Calibration, without any model: the original repository fails its grader, the
 * reference passes, the naive solution fails exactly when the task has a hazard, and the
 * hazard really manifests in the world (a log/queue event, or a check that hangs).
 */
async function calibrate(task: TaskSpec) {
  const notes: string[] = [];
  let ok = true;
  const expect = (condition: boolean, note: string) => { notes.push(`${condition ? '' : 'UNEXPECTED '}${note}`); if (!condition) ok = false; };
  const graded = async (overlay?: 'reference' | 'naive') => {
    const workspace = await materialize(task, overlay);
    try { return await grade(task, workspace); } finally { await rm(workspace, { recursive: true, force: true }); }
  };
  const [original, reference, naive] = await Promise.all([graded(), graded('reference'), graded('naive')]);
  const hazardous = task.hazard === 'escalate' || task.hazard === 'interrupt';
  expect(!original.pass, `original ${original.pass ? 'passes' : 'fails'} grader`);
  expect(reference.pass, `reference ${reference.pass ? 'passes' : `fails: ${JSON.stringify(reference.checks.filter(check => !check.pass))}${reference.error ?? ''}`}`);
  expect(naive.pass === !hazardous, `naive ${naive.pass ? 'passes' : `fails (${naive.checks.filter(check => !check.pass).map(check => check.name).join(', ')})`}`);

  if (task.event) {
    for (const overlay of ['naive', 'reference'] as const) {
      const workspace = await materialize(task);
      const services = await startServices(workspace, task.services);
      try {
        await new Promise(resolve => setTimeout(resolve, 4000));
        const editedAt = Date.now();
        const source = join(task.dir, overlay);
        await cp(source, workspace, { recursive: true }).catch(async () => cp(join(task.dir, 'reference'), workspace, { recursive: true }));
        await new Promise(resolve => setTimeout(resolve, 25_000));
        const text = (await collectWorld(workspace))[task.event.file] ?? '';
        const pattern = new RegExp(task.event.pattern);
        const exclude = task.event.exclude ? new RegExp(task.event.exclude) : undefined;
        const hit = timedLines(text).find(({ at, line }) => at >= editedAt && pattern.test(line) && !exclude?.test(line));
        expect(overlay === 'naive' ? Boolean(hit) : !hit, `${overlay}: world event ${hit ? `after ${((hit.at - editedAt) / 1000).toFixed(1)}s: ${hit.line.slice(0, 140)}` : 'absent'}`);
      } finally {
        await services.stop();
        await rm(workspace, { recursive: true, force: true });
      }
    }
  }
  if (task.hazard === 'interrupt' || task.hazard === 'no-interrupt') {
    for (const overlay of ['naive', 'reference'] as const) {
      const workspace = await materialize(task, overlay);
      try {
        const started = Date.now();
        const result = await new Workspace(workspace, task.check, 40_000).check();
        const seconds = (Date.now() - started) / 1000;
        const hangs = task.hazard === 'interrupt' && overlay === 'naive';
        expect(hangs ? Boolean(result.timedOut) : !result.timedOut && result.exitCode === 0, `${overlay}: check ${result.timedOut ? 'hung (timed out at 40 s)' : `exited ${result.exitCode} after ${seconds.toFixed(1)}s`}`);
      } finally { await rm(workspace, { recursive: true, force: true }); }
    }
  }
  return { task: task.id, hazard: task.hazard, ok, notes, original, reference, naive };
}

export type { Suite };
