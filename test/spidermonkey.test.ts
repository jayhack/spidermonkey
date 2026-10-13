import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Question, S1Evaluate } from '../src/monitor.js';
import { Spidermonkey, type FeedItem } from '../src/spidermonkey/core.js';
import { Daemon, socketPath, toStep } from '../src/spidermonkey/daemon.js';
import { identify, scrub, type AppSample, type Frame } from '../src/spidermonkey/machine.js';

const app = (name: string, rssMb: number, options: Partial<AppSample> = {}): AppSample =>
  ({ key: `app:${name}`, name, kind: 'gui', processes: 3, cpu: 1, rssMb, ...options });
const frame = (at: number, apps: AppSample[], extra: Partial<Frame> = {}): Frame =>
  ({ at, apps: new Map(apps.map(item => [item.key, item])), ports: new Map(), files: new Map(), commands: new Map(), ...extra });

/** Scripted System 1: everything is salient; urgency and priority come from the test. */
function scripted(urgency: number, priority: number, keep = 0.9) {
  const states: unknown[] = [];
  const evaluate: S1Evaluate = async (state, questions: Record<string, Question>) => {
    states.push(state);
    return { inputTokens: 10, costUsd: 0.0001, answers: Object.fromEntries(Object.keys(questions).map(key => [key,
      key.startsWith('e') ? { type: 'boolean', probability: 0.9 } : key.startsWith('u') ? { type: 'score', score: urgency }
        : key.startsWith('p') ? { type: 'score', score: priority } : { type: 'boolean', probability: keep }])) };
  };
  return { evaluate, states };
}

test('processes group into apps, interpreters are named by what they run, credentials are scrubbed', () => {
  assert.equal(identify('/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)', '').key, 'app:Google Chrome');
  assert.equal(identify('/Applications/Slack.app/Contents/MacOS/Slack', '').kind, 'gui');
  assert.deepEqual(identify('/System/Applications/Calculator.app/Contents/MacOS/Calculator', ''), { key: 'app:Calculator', name: 'Calculator', kind: 'gui' });
  assert.equal(identify('/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari', '').kind, 'gui');
  assert.equal(identify('/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock', '').kind, 'system');
  assert.equal(identify('/usr/local/bin/node', 'node /repo/node_modules/.bin/vite --port 3000').key, 'proc:node vite');
  assert.equal(identify('/usr/libexec/logd', '').kind, 'system');
  assert.equal(identify('(bash)', '(bash)').kind, 'system');
  assert.equal(identify('/usr/local/bin/node', 'node -e const a = 1').name, 'node (inline script)');
  assert.equal(scrub('curl -H Authorization: Bearer abc123 --token=hunter2 sk-live_0123456789abcdef'), 'curl -H Authorization: <redacted> abc123 --token=<redacted> <redacted>');
});

test('at boot System 1 adopts what matters; a newly opened app and a memory spike become findings', async () => {
  const { evaluate, states } = scripted(3, 2);
  const monkey = new Spidermonkey({ audience: 'human', callsPerMinute: 60, appraiser: 'system1' }, evaluate);
  const feed: FeedItem[] = [];
  monkey.on(item => feed.push(item));
  await monkey.tick(frame(1, [app('Google Chrome', 1200), app('Slack', 400)]));
  assert.equal(monkey.entities.get('app:Google Chrome')?.priority, 2, 'adopted at boot at the priority System 1 chose');
  assert.equal(monkey.findings.length, 0, 'nothing to report about the first frame');
  await monkey.tick(frame(2, [app('Google Chrome', 1250), app('Slack', 400), app('Figma', 300), app('egrep', 2, { kind: 'cli', key: 'proc:egrep' })]));
  assert.equal(monkey.findings.length, 0, 'a new program must survive a second frame');
  await monkey.tick(frame(2.5, [app('Google Chrome', 1250), app('Slack', 400), app('Figma', 300)]));
  assert.match(monkey.findings.at(-1)!.text, /App opened: Figma/);
  assert.ok(!monkey.findings.some(finding => /egrep/.test(finding.text)), 'a one-frame command is not news');
  await monkey.tick(frame(3, [app('Google Chrome', 2600), app('Slack', 400), app('Figma', 300)]));
  const spike = monkey.findings.at(-1)!;
  assert.match(spike.text, /Google Chrome memory 1\.2 GB → 2\.5 GB/);
  assert.equal(spike.mode, 'interrupt', 'urgent and closely watched');
  assert.ok((states.at(-1) as { previousFrame: unknown }).previousFrame, 'judgment sees the previous frame');
  assert.equal(monkey.drain().length, 2);
  assert.equal(monkey.drain().length, 0);
  assert.ok(feed.some(item => item.type === 'attention' && item.to === 2));
});

test('log lines habituate: a line shape seen before is routine; a new shape is an event', async () => {
  const monkey = new Spidermonkey({ audience: 'agent', callsPerMinute: 60, appraiser: 'all' });
  monkey.register({ id: 'file:/srv/app.log', kind: 'file', label: 'app.log', priority: 2, spec: { path: '/srv/app.log' } });
  const lines = (...text: string[]) => new Map([['/srv/app.log', { path: '/srv/app.log', size: 1, lines: text }]]);
  await monkey.tick(frame(1, [], { files: lines('2026-10-01T10:00:00Z GET /orders/1 200 3ms') }));
  await monkey.tick(frame(2, [], { files: lines('2026-10-01T10:00:01Z GET /orders/77 200 9ms') }));
  await monkey.tick(frame(3, [], { files: lines('2026-10-01T10:00:02Z ERROR db: connection refused') }));
  const texts = monkey.findings.map(finding => finding.evidence);
  assert.equal(monkey.findings.length, 2, 'the second GET line has the same shape as the first');
  assert.match(texts.at(-1)!, /ERROR db: connection refused/);
});

test('the agent trace steers attention: a port it mentions is offered and adopted', async () => {
  const { evaluate, states } = scripted(1, 3);
  const monkey = new Spidermonkey({ audience: 'agent', callsPerMinute: 60, appraiser: 'system1', task: 'Fix the checkout page' }, evaluate);
  await monkey.tick(frame(1, []));
  monkey.ingest({ at: 2, kind: 'message', text: 'Started the dev server; open http://localhost:5173 to check the page.' });
  await monkey.tick(frame(2, [], { ports: new Map([[5173, { port: 5173, app: 'node' }]]) }));
  assert.equal(monkey.entities.get('port:5173')?.priority, 3);
  assert.match(monkey.entities.get('port:5173')!.reason!, /the agent mentioned it|started listening/);
  assert.match(JSON.stringify((states.at(-1) as { recentAgentSteps: string[] }).recentAgentSteps), /localhost:5173/);
});

test('ROS harness events become agent steps; hidden reasoning is never inferred', () => {
  assert.deepEqual(toStep({ at: '2026-10-01T00:00:00Z', lane: 'executive', kind: 'tool', data: { toolName: 'read_file', path: 'src/a.ts' } })?.text, 'read_file src/a.ts');
  assert.equal(toStep({ lane: 'system1', kind: 'appraisal', message: 'x' }), undefined);
  assert.equal(toStep({ kind: 'message', text: 'hello' })?.text, 'hello');
});

test('the daemon serves watch, status and drain over its socket, and runs watched commands', async t => {
  const home = await mkdtemp(join(tmpdir(), 'spidermonkey-'));
  const cwd = await mkdtemp(join(tmpdir(), 'spidermonkey-cwd-'));
  await writeFile(join(cwd, 'state.txt'), 'pass\n');
  const daemon = new Daemon({ home, cwd, intervalMs: 60_000, audience: 'agent', callsPerMinute: 60, appraiser: 'all',
    sampler: async () => ({ at: Date.now(), apps: new Map(), ports: new Map(), files: new Map() }) });
  t.after(async () => { await daemon.stop(); await rm(home, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); });
  await daemon.start();
  const call = (method: string, path: string, body?: unknown) => new Promise<unknown>((done, fail) => {
    const req = request({ socketPath: socketPath(home), path, method }, response => { let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => done(JSON.parse(text))); });
    req.on('error', fail);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  await call('POST', '/watch', { id: 'command:tests', kind: 'command', label: 'tests', priority: 3, spec: { command: 'grep -q pass state.txt && echo "1 passed" || { echo "1 failed"; exit 1; }', everySeconds: 0 } });
  await daemon.tick(); await daemon.settle(); await daemon.tick();
  await writeFile(join(cwd, 'state.txt'), 'broken\n');
  await daemon.tick(); await daemon.settle(); await daemon.tick();
  const findings = await call('POST', '/drain') as Array<{ text: string }>;
  assert.ok(findings.some(finding => /tests .* exited 1 .*different from its last run/.test(finding.text)), JSON.stringify(findings));
  const status = await call('GET', '/status') as { entities: Array<{ id: string }> };
  assert.ok(status.entities.some(entity => entity.id === 'command:tests'));
  await call('POST', '/trace', { kind: 'message', text: 'running the tests again' });
  assert.equal(daemon.monkey.steps.at(-1)?.text, 'running the tests again');
  await appendFile(join(home, 'feed.jsonl'), '');
});
