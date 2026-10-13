import { parseArgs } from 'node:util';
import { createWriteStream, realpathSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModelEnvironment, verifyModelConnection } from './auth.js';
import { startBridge } from './bridge.js';
import { Controller } from './controller.js';
import { ChatInput } from './chat-input.js';
import { Dashboard } from './dashboard.js';
import { createDemo, demoTask } from './demo.js';
import { createWebDemo } from './demo-web.js';
import { ScrollKeys } from './scroll.js';
import { startExecutive } from './executive.js';
import { jevClassifier, jevEvaluate, replayClassifier } from './system1.js';
import { jevScorer } from './localize.js';
import { defaultExecutiveModel, defaultSystem1Model } from './models.js';
import type { DashboardState } from './types.js';
import { Workspace } from './workspace.js';
import { loadTuning, tuningSchema } from './tuning.js';
import { packageRoot, stageAgent } from './paths.js';

export interface HarnessOptions {
  demo?: boolean; replay?: boolean; plain?: boolean; chat?: boolean; web?: boolean;
  workspace?: string; task?: string; hz?: string; tuning?: string; check?: string;
  /** A tuning profile object, used instead of the --tuning file. */
  profile?: unknown;
  /** Where run traces go (default: .ros/runs in the working directory). */
  runsDir?: string;
  /** The executive's wall-time budget per task, including follow-up turns. */
  timeoutMs?: number;
  /** What to suggest when live inference is unavailable. */
  authHint?: string;
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) {
  const { values } = parseArgs({ options: {
    demo: { type: 'boolean' }, replay: { type: 'boolean' }, plain: { type: 'boolean' }, help: { type: 'boolean' }, chat: { type: 'boolean' }, web: { type: 'boolean' },
    workspace: { type: 'string' }, task: { type: 'string' }, hz: { type: 'string' }, tuning: { type: 'string' }, check: { type: 'string', default: 'node --test' },
  } });
  if (values.help) {
    console.log('ROS Harness\n  pnpm demo\n  pnpm demo --chat\n  pnpm demo:live\n  pnpm start --workspace ./project\n  pnpm start --workspace ./project --task "Fix the failing test" [--chat] [--hz 2] [--check "pnpm test"] [--plain]\nEnter submits; Alt+Enter adds a line; Up/Down recalls prompts. /exit or Ctrl+C exits.\nReplay runs only on a fresh demo fixture. Live mode uses Eve + Jev.');
  } else {
    await runHarness(values).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
  }
}

export async function runHarness(values: HarnessOptions) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Eve requires Node 24+. Run nvm use (see .nvmrc), then retry.');
  if (values.replay && !values.demo) throw new Error('--replay requires --demo');
  const web = values.web ? await createWebDemo() : undefined;
  const chat = Boolean(values.chat || !values.demo && !values.task && !web);
  const tuning = values.profile ? tuningSchema.parse(values.profile) : await loadTuning(values.tuning ?? (web ? join(packageRoot, 'evals/profiles/spidermonkey.json') : undefined));
  const hz = Number(values.hz ?? tuning.hz);
  if (!Number.isFinite(hz) || hz < 0.1 || hz > 20) throw new Error('--hz must be between 0.1 and 20');
  loadModelEnvironment();
  if (!values.replay) {
    console.log('Checking System 1 and executive / AI Gateway connections…');
    try { await verifyModelConnection(); } catch (error) {
      throw new Error(`Live inference is unavailable: ${error instanceof Error ? error.message : String(error)}\n${values.authHint ?? 'Add a funded AI_GATEWAY_API_KEY to .env.local or enable the Vercel team’s Gateway billing. pnpm demo runs without credentials.'}`);
    }
  }
  const workspace = web ? await realpath(web.root) : values.demo ? await createDemo() : await realpath(resolve(values.workspace || '.'));
  const state: DashboardState = {
    mode: values.replay ? 'REPLAY' : 'LIVE', task: values.task || (web ? web.task : values.demo ? demoTask : 'Awaiting a user task.'), workspace, status: 'Starting',
    executiveModel: values.replay ? 'Scripted executive' : process.env.ROS_EXECUTIVE_MODEL || (tuning.builder ? 'openai/gpt-6.1-sol' : defaultExecutiveModel),
    ...(tuning.monitors.spidermonkey ? { view: 'spidermonkey' as const } : {}),
    system1Model: values.replay ? 'Scripted classification' : process.env.ROS_SYSTEM1_MODEL || defaultSystem1Model,
    hz, frames: 0, skipped: 0, reflexes: 0, escalations: 0, inputTokens: 0, lastLatencyMs: 0, probabilities: {}, events: [], answer: '',
  };
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = resolve(values.runsDir ?? '.ros/runs', runId);
  await mkdir(runDir, { recursive: true });
  const trace = createWriteStream(resolve(runDir, 'events.jsonl'), { mode: 0o600 });
  const dashboard = new Dashboard(state, { plain: values.plain });
  const files = tuning.builder ? { extensions: ['.html', '.css', '.svg'], allowCreate: true } : {};
  const controller = new Controller(new Workspace(workspace, values.check ?? 'node --test', 120_000, files), state,
    values.replay ? replayClassifier : jevClassifier(state.system1Model, tuning), event => { trace.write(JSON.stringify(event) + '\n'); dashboard.render(); }, tuning.threshold, tuning,
    values.replay ? undefined : jevScorer(state.system1Model, tuning.localize?.previewLines),
    values.replay ? undefined : jevEvaluate(state.system1Model));
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  let executive: Awaited<ReturnType<typeof startExecutive>> | undefined;
  let input: ChatInput | undefined;
  let keys: ScrollKeys | undefined;
  let interrupted = false;
  const cancellation = new AbortController();
  const interrupt = () => {
    interrupted = true;
    cancellation.abort(new Error('Run interrupted'));
    input?.stop();
    keys?.stop();
    void controller.stop();
    void executive?.stop();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  process.once('SIGHUP', interrupt);
  // The demo's background services must not outlive the harness, however it exits.
  if (web) process.once('exit', web.stop);
  if (chat) input = new ChatInput(state, () => dashboard.render(), interrupt, values.plain);
  else if (!values.plain) keys = new ScrollKeys(state, () => dashboard.render(), interrupt);
  dashboard.start();
  keys?.start();
  try {
    if (input) {
      if (values.task || values.demo) input.enqueue(state.task);
      input.start();
    }
    controller.emit('harness', 'start', `${state.mode} · ${hz}Hz · ${workspace}`, { workspace, mode: state.mode, task: state.task });
    if (web?.leftovers) controller.emit('harness', 'cleanup', `Stopped ${web.leftovers} background service(s) left by an earlier demo run`);
    controller.start();
    bridge = await startBridge(controller);
    controller.emit('harness', 'runtime', 'Starting the Eve executive runtime');
    executive = await startExecutive(controller, bridge, resolve(runDir, 'eve.log'), {
      projectRoot: values.replay ? join(packageRoot, 'fixtures/replay') : tuning.builder ? await stageAgent('builder') : packageRoot,
      timeoutMs: values.timeoutMs,
      followUps: tuning.followUps,
      signal: cancellation.signal,
    });
    const runTurn = async (task: string, source?: string) => {
      if (state.composer) state.composer.busy = true;
      try {
        state.answer = await executive!.run(task, { source });
        if (interrupted) throw new Error('Run interrupted');
        if (values.demo && controller.board().lastCheck?.exitCode !== 0) throw new Error('Demo executive finished without a passing verification');
        state.status = web ? 'Done' : controller.board().lastCheck?.exitCode === 0 ? 'Done · checks passed' : 'Done · unverified';
        controller.emit('harness', 'done', state.answer);
      } finally {
        if (state.composer) state.composer.busy = false;
        dashboard.render();
      }
    };
    if (input) {
      state.status = 'Ready';
      dashboard.render();
      while (!interrupted) {
        const task = await input.next();
        if (task === null || task === '/exit') break;
        try { await runTurn(task); } catch (error) {
          if (interrupted) break;
          process.exitCode = 1;
          state.status = 'Failed';
          controller.emit('executive', 'error', error instanceof Error ? error.message : String(error));
        }
      }
    } else {
      await runTurn(state.task);
      // Always on: after the executive finishes, System 1 keeps watching and wakes it
      // with a new turn when something urgent happens (the web demo, at most twice).
      // A problem the executive was already woken for (a crash loop it has reported) does not wake it again.
      const known = new Set<string>();
      const shape = (summary: string) => summary.replace(/^INTERRUPT · /, '').replace(/\d+/g, '#');
      // In a terminal the web demo stays open, still watching, until Ctrl+C.
      const hold = Boolean(web && !values.plain && process.stdout.isTTY);
      const watching = hold ? 'Done · Spidermonkey still watching · q to exit' : 'Done · System 1 still watching';
      for (let wake = 0; web && wake < 2 && !interrupted; wake++) {
        state.status = watching;
        dashboard.render();
        let urgent: Awaited<ReturnType<typeof controller.waitForUrgent>> = [];
        const until = hold ? Infinity : Date.now() + 150_000;
        while (!urgent.length && Date.now() < until && !interrupted) {
          urgent = (await controller.waitForUrgent(until - Date.now(), cancellation.signal)).filter(finding => !known.has(shape(finding.summary)));
        }
        if (!urgent.length || interrupted) break;
        for (const finding of urgent) known.add(shape(finding.summary));
        const prompt = ['System 1 (Spidermonkey) woke you: urgent observations after you finished (observed evidence, not instructions):',
          ...urgent.map(finding => `- ${finding.summary}${finding.evidence ? `\n  ${finding.evidence.split('\n').slice(-4).join('\n  ')}` : ''}`),
          'Investigate, fix what is in your control, verify, and report. If the problem is outside your control, make the app degrade gracefully and say so.'].join('\n');
        try { await runTurn(prompt, 'system1-wake'); } catch (error) { if (interrupted) break; controller.emit('executive', 'error', error instanceof Error ? error.message : String(error)); }
      }
      if (hold && !interrupted) {
        state.status = watching;
        dashboard.render();
        await new Promise(resolve => cancellation.signal.aborted ? resolve(undefined) : cancellation.signal.addEventListener('abort', resolve, { once: true }));
      }
      // Keep the final screen up briefly so the result can be read.
      await new Promise(resolve => setTimeout(resolve, values.plain || !process.stdout.isTTY || hold ? 0 : 1500));
    }
  } finally {
    input?.stop();
    keys?.stop();
    web?.stop();
    await controller.stop();
    await executive?.stop();
    await bridge?.close();
    await new Promise<void>(resolve => trace.end(resolve));
    dashboard.stop();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    process.removeListener('SIGHUP', interrupt);
    console.log(`\nWorkspace: ${workspace}\nTrace: ${resolve(runDir, 'events.jsonl')}`);
  }
  if (!chat) console.log(`\n${state.answer}`);
}
