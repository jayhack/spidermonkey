import { request } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadModelEnvironment } from '../auth.js';
import { defaultSystem1Model } from '../models.js';
import { jevEvaluate } from '../system1.js';
import { terminalTheme as t } from '../theme.js';
import { priorities, type Entity, type FeedItem, type Priority } from './core.js';
import { Daemon, socketPath } from './daemon.js';

const usage = `spidermonkey: an always-on System 1 for your machine and the agent working on it

  spidermonkey ui      [--task TEXT] [--trace FILE] [--interval SEC] [--appraiser system1|all] [--audience human|agent] [--quiet]
                       watch the machine in this terminal (starts a daemon in-process, or attaches to a running one);
                       dim lines show what System 1 noticed and dismissed (--quiet hides them)
  spidermonkey start   [same options]            run headless; the feed goes to ~/.spidermonkey/feed.jsonl
  spidermonkey watch   --app NAME | --port N | --file PATH | --cmd "COMMAND" [--name NAME] [--every SEC] [--priority focus|watch|background]
  spidermonkey unwatch ID
  spidermonkey status
  spidermonkey drain                             undelivered findings as JSON (for an agent's next tool call)
  spidermonkey trace   --text "..." [--kind message|tool|result]   add an agent step`;

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  task: { type: 'string' }, trace: { type: 'string' }, interval: { type: 'string', default: '2' },
  appraiser: { type: 'string', default: 'system1' }, audience: { type: 'string', default: 'human' },
  app: { type: 'string' }, port: { type: 'string' }, file: { type: 'string' }, cmd: { type: 'string' },
  name: { type: 'string' }, every: { type: 'string', default: '30' }, priority: { type: 'string', default: 'watch' },
  text: { type: 'string' }, kind: { type: 'string', default: 'message' }, home: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  quiet: { type: 'boolean', short: 'q' },
} });
const home = values.home ?? join(homedir(), '.spidermonkey');
const command = positionals[0];

function call(method: string, path: string, body?: unknown): Promise<unknown> {
  return new Promise((done, fail) => {
    const req = request({ socketPath: socketPath(home), path, method, headers: { 'content-type': 'application/json' } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => { try { done(JSON.parse(text)); } catch { done(text); } });
    });
    req.on('error', fail);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const running = () => call('GET', '/status').then(() => true, () => false);

const clock = (at: number) => new Date(at).toTimeString().slice(0, 8);
const level = (priority: Priority | null) => priority === null ? 'dropped' : priorities[priority];
const paint = (priority: Priority | null) => priority === null ? t.dim : priority >= 3 ? t.bright : priority === 2 ? t.signal : t.muted;

function render(item: FeedItem) {
  if (item.type === 'finding') {
    const finding = item.finding;
    const tone = finding.severity === 'error' ? t.danger : finding.severity === 'warn' ? t.warning : t.body;
    const mark = finding.mode === 'interrupt' ? `${t.danger}⚡ INTERRUPT` : `${tone}⚑ notify`;
    console.log(`${t.dim}${clock(finding.at)}${t.reset} ${mark}${t.reset} ${tone}${finding.text}${t.reset} ${t.dim}P=${finding.probability.toFixed(2)} urgency ${finding.urgency.toFixed(1)}${t.reset}`);
    if (finding.evidence) for (const line of finding.evidence.split('\n').slice(-6)) console.log(`${t.dim}         │ ${line.slice(0, 160)}${t.reset}`);
  } else if (item.type === 'attention') {
    const arrow = item.from === null ? '+' : item.to === null ? '−' : item.to > item.from ? '↑' : item.to < item.from ? '↓' : '=';
    console.log(`${t.dim}${clock(item.at)}${t.reset} ${paint(item.to)}${arrow} ${level(item.to).padEnd(10)}${t.reset} ${item.label} ${t.dim}— ${item.reason}${t.reset}`);
  } else if (item.type === 'appraisal') {
    console.log(`${t.dim}${clock(item.at)} · System 1 appraised ${item.events} event(s), ${item.candidates} candidate(s)${item.reviews ? `, ${item.reviews} review(s)` : ''} in ${item.latencyMs} ms${item.costUsd === undefined ? '' : ` ($${item.costUsd.toFixed(5)})`}${t.reset}`);
  } else if (item.type === 'dismissed') {
    if (values.quiet) return;
    console.log(`${t.dim}${clock(item.at)} · noticed  ${item.text} — not worth attention (P=${item.probability.toFixed(2)}, urgency ${item.urgency.toFixed(1)})${t.reset}`);
  } else if (item.type === 'declined') {
    if (values.quiet) return;
    console.log(`${t.dim}${clock(item.at)} · ignored  ${item.label} — ${item.why} (priority score ${item.score.toFixed(2)})${t.reset}`);
  } else console.log(`${t.dim}${clock(item.at)}${t.reset} ${t.danger}error${t.reset} ${item.message}`);
}

async function daemon(serve: boolean) {
  loadModelEnvironment();
  const instance = new Daemon({ home, cwd: process.cwd(), intervalMs: Number(values.interval) * 1000, trace: values.trace ? resolve(values.trace) : undefined,
    audience: values.audience === 'agent' ? 'agent' : 'human', task: values.task, callsPerMinute: 12, appraiser: values.appraiser === 'all' ? 'all' : 'system1',
    evaluate: values.appraiser === 'all' ? undefined : jevEvaluate(process.env.ROS_SYSTEM1_MODEL || defaultSystem1Model) });
  const stop = async () => { await instance.stop(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await instance.start({ serve });
  return instance;
}

if (values.help || !command) { console.log(usage); process.exit(command ? 0 : 1); }
if (command === 'ui') {
  console.log(`${t.bright}spidermonkey${t.reset} ${t.dim}watching this machine${values.task ? ` for: ${values.task}` : ''}${values.trace ? ` · agent trace ${values.trace}` : ''} · Ctrl+C to stop${t.reset}`);
  if (await running()) {
    console.log(`${t.dim}attached to the running daemon at ${socketPath(home)}${t.reset}`);
    const status = await call('GET', '/status') as { entities: Entity[] };
    for (const entity of status.entities) render({ type: 'attention', at: Date.now(), entity: entity.id, label: entity.label, from: null, to: entity.priority, reason: entity.reason ?? entity.source });
    request({ socketPath: socketPath(home), path: '/feed', method: 'GET' }, response => {
      let buffer = '';
      response.on('data', chunk => { buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop()!; for (const line of lines) if (line) render(JSON.parse(line)); });
    }).end();
  } else {
    const instance = await daemon(true);
    instance.monkey.on(render);
  }
} else if (command === 'start') {
  if (await running()) { console.log(`already running at ${socketPath(home)}`); process.exit(0); }
  await daemon(true);
  console.log(`spidermonkey running · socket ${socketPath(home)} · feed ${join(home, 'feed.jsonl')}`);
} else {
  if (!(await running())) { console.error(`No daemon at ${socketPath(home)}. Run "spidermonkey ui" or "spidermonkey start" first.`); process.exit(1); }
  const priority = Math.max(1, priorities.indexOf(values.priority as typeof priorities[number])) as Priority;
  if (command === 'watch') {
    const entity = values.app ? { id: `app:${values.app}`, kind: 'app', label: values.app }
      : values.port ? { id: `port:${values.port}`, kind: 'port', label: `:${values.port}` }
      : values.file ? { id: `file:${resolve(values.file)}`, kind: 'file', label: values.file, spec: { path: resolve(values.file) } }
      : values.cmd ? { id: `command:${values.name ?? values.cmd.split(/\s+/).slice(0, 2).join(' ')}`, kind: 'command', label: values.name ?? values.cmd, spec: { command: values.cmd, everySeconds: Number(values.every) } }
      : undefined;
    if (!entity) { console.error(usage); process.exit(1); }
    console.log(JSON.stringify(await call('POST', '/watch', { ...entity, priority, reason: 'registered from the CLI' }), null, 2));
  } else if (command === 'unwatch') console.log(JSON.stringify(await call('POST', '/unwatch', { id: positionals[1] })));
  else if (command === 'status') console.log(JSON.stringify(await call('GET', '/status'), null, 2));
  else if (command === 'drain') console.log(JSON.stringify(await call('POST', '/drain'), null, 2));
  else if (command === 'trace') console.log(JSON.stringify(await call('POST', '/trace', { kind: values.kind, text: values.text ?? '' })));
  else { console.error(usage); process.exit(1); }
}
