import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

test('coding chat repairs the demo and handles a follow-up in the same Eve session', { timeout: 60_000 }, async t => {
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), '--demo', '--replay', '--chat', '--plain'], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
    // This is a real CLI process. Inheriting the test runner's context makes its
    // workspace checks silently skip their test files as recursive test runs.
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 45_000);
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill('SIGTERM'); });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.stdin.end('What changed in the cart code?\n/exit\n');
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  assert.equal(code, 0, output);
  assert.equal(output.match(/\[executive\] session:/g)?.length, 1, 'follow-ups must reuse the same durable session');
  assert.equal(output.match(/\[executive\] prompt:/g)?.length, 2, 'both user turns must reach the executive');
  assert.match(output, /Replay follow-up: What changed in the cart code\?/);
  assert.match(output, /sum \+ item\.price \* item\.quantity/);
  assert.match(output, /verification command exited with code 0/);
  assert.doesNotMatch(output, /\[executive\] error:/);
});
