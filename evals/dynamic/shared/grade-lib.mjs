// Hidden grading helpers. Graders run after the attempt, with services stopped, as
//   node evals/dynamic/tasks/<id>/grader.mjs <workspace>
// Every piece of workspace code runs in a child process group with a timeout.
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const workspace = process.argv[2];
if (!workspace) throw new Error('usage: grader.mjs <workspace>');
const checks = [];

/** A path inside the grader's own task directory. */
export const taskPath = (graderUrl, relative) => fileURLToPath(new URL(relative, graderUrl));

export function record(name, pass, detail = '') {
  checks.push({ name, pass: Boolean(pass), detail: String(detail ?? '').slice(0, 800) });
}

/** Run a command in the workspace in its own process group; the group is killed on timeout. */
export function run(command, args, { timeoutMs = 30_000, cwd = workspace } = {}) {
  return new Promise(done => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    child.stdout.on('data', data => { output = (output + data).slice(-200_000); });
    child.stderr.on('data', data => { output = (output + data).slice(-200_000); });
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); kill(); done({ code, timedOut, output, ms: Date.now() - started }); });
  });
}

/**
 * Evaluate an ES module snippet in a fresh Node process. `load(path)` imports a workspace
 * module; `report(value)` returns a JSON value to the grader.
 */
export async function evaluate(code, { timeoutMs = 30_000, nodeArgs = [] } = {}) {
  const base = pathToFileURL(join(workspace, '/')).href;
  const prelude = `const load = path => import(${JSON.stringify(base)} + path); const report = value => console.log('@@' + JSON.stringify(value));\n`;
  const result = await run(process.execPath, [...nodeArgs, '--input-type=module', '-e', prelude + code], { timeoutMs });
  const line = result.output.split('\n').find(item => item.startsWith('@@'));
  return { ...result, value: line ? JSON.parse(line.slice(2)) : undefined };
}

/** Run hidden test files (copied into the workspace next to its own tests) with `node --test`. */
export async function hiddenTests(directory, { timeoutMs = 30_000 } = {}) {
  const target = join(workspace, 'test_hidden');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const files = readdirSync(directory).filter(name => name.endsWith('.js'));
  for (const name of files) writeFileSync(join(target, name), readFileSync(join(directory, name)));
  try {
    const result = await run(process.execPath, ['--test', ...files.map(name => join('test_hidden', name))], { timeoutMs });
    record('hidden tests pass and the runner exits', result.code === 0 && !result.timedOut,
      result.timedOut ? `runner did not exit within ${timeoutMs / 1000}s\n${result.output.slice(-600)}` : result.output.split('\n').filter(line => /^ℹ (pass|fail)|✖/.test(line)).slice(0, 12).join('\n'));
    return result;
  } finally { rmSync(target, { recursive: true, force: true }); }
}

/** The workspace's own visible test suite, as the executive ran it. */
export async function visibleSuite({ timeoutMs = 60_000 } = {}) {
  const result = await run(process.execPath, ['--test'], { timeoutMs });
  record('visible suite passes and exits', result.code === 0 && !result.timedOut, result.timedOut ? `did not exit within ${timeoutMs / 1000}s` : result.output.split('\n').filter(line => /^ℹ (pass|fail)/.test(line)).join(' '));
  return result;
}

export function finish() {
  console.log(JSON.stringify({ pass: checks.length > 0 && checks.every(check => check.pass), checks }));
}
