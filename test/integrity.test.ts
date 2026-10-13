import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Controller } from '../src/controller.js';
import type { S1Evaluate } from '../src/monitor.js';
import { enclosing, isTestPath, parseUnifiedDiff, removedDefinitions, testConcerns } from '../src/monitors/integrity.js';
import type { DashboardState } from '../src/types.js';
import { Workspace } from '../src/workspace.js';

const base: Record<string, string> = {
  'pkg/mod.py': 'import os\n\n\ndef helper_function(x):\n    return os.path.join(x, "a")\n\n\nclass Widget:\n    def render(self):\n        return helper_function("w") + legacy_global\n',
  'pkg/use.py': 'from pkg.mod import helper_function\n\nprint(helper_function("z"))\n',
  'tests/test_cli.py': [
    'import pytest', '', '', 'class TestRoutes:', '    def expect_order(self, order, output):',
    '        # skip the header and match the start of each row', '        for expect, line in zip(order, output.splitlines()[2:]):',
    '            assert line[: len(expect)] == expect', '', '    def test_simple(self):', '        assert 1 == 1', '',
  ].join('\n'),
};

function state(root: string, task: string): DashboardState {
  return { mode: 'test', task, workspace: root, status: 'Working', executiveModel: 'test', system1Model: 'test', hz: 2,
    frames: 0, skipped: 0, reflexes: 0, escalations: 0, inputTokens: 0, lastLatencyMs: 0, probabilities: {}, events: [], answer: '' };
}

// Scripted System 1: environment observations are salient urgent failures. For the
// executive's own change it answers `unwarranted` (asked only for self-observations)
// from the task: a task that asks for the new format warrants rewriting old expectations.
// That is the judgment the rule-based ablations lack.
const seen: Array<{ stream: string; content: string }> = [];
const scripted: S1Evaluate = async (s1State, questions) => {
  const { observation, task } = s1State as { observation: { stream: string; content: string }; task: string };
  seen.push(observation);
  return { inputTokens: 10, costUsd: 0.0001, answers: {
    salient: { type: 'boolean', probability: 0.9 },
    kind: { type: 'choice', choice: 'failure' },
    urgency: { type: 'score', score: 3 },
    ...('unwarranted' in questions ? { unwarranted: { type: 'boolean', probability: /new format/.test(task) ? 0.1 : 0.9 } } : {}),
  } };
};

const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', ...args], { cwd: root, stdio: 'pipe' }).toString();

async function fixture(t: TestContext, perception: Record<string, unknown>, extra: Record<string, unknown> = {}, task = 'Make routes show the domain of each rule.') {
  seen.length = 0;
  const root = await mkdtemp(join(tmpdir(), 'ros-integrity-'));
  for (const [path, content] of Object.entries(base)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  const board = state(root, task);
  const controller = new Controller(new Workspace(root, 'exit 0'), board, async () => { throw new Error('legacy classifier must not run'); },
    undefined, 0.85, { enabled: false, monitors: { perception: { integrity: { python: ['python3'], debounceMs: 20 }, ...perception } }, deliverWaitMs: 10_000, followUps: 1, ...extra },
    undefined, scripted);
  t.after(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });
  return { controller, board, root };
}

type Reported = { system1?: Array<{ monitor: string; severity: string; summary: string; evidence?: string }> };
const edit = async (controller: Controller, path: string, oldText: string, newText: string) => {
  await controller.tool('read_file', { path });
  return await controller.tool('replace_text', { path, oldText, newText }) as Reported;
};

test('diff facts: rewritten existing assertions are concerns; added tests are not', () => {
  const diff = [
    'diff --git a/tests/test_cli.py b/tests/test_cli.py', '--- a/tests/test_cli.py', '+++ b/tests/test_cli.py',
    '@@ -6,3 +6,3 @@ class TestRoutes:', '         for expect, line in zip(order, output.splitlines()[2:]):', '-            assert line[: len(expect)] == expect', '+            assert expect in line.split()', ' ',
    '@@ -11,0 +12,3 @@ def test_simple(self):', '+', '+def test_new():', '+    assert True',
  ].join('\n');
  const [file] = parseUnifiedDiff(diff);
  assert.equal(file!.path, 'tests/test_cli.py');
  assert.deepEqual([file!.added, file!.removed], [4, 1]);
  const concerns = testConcerns(file!, base['tests/test_cli.py']!.split('\n').slice(2));
  assert.equal(concerns.length, 1);
  assert.match(concerns[0]!.label, /existing assertion changed in TestRoutes\.expect_order/);
  assert.deepEqual(concerns[0]!.detail, ['- assert line[: len(expect)] == expect', '+ assert expect in line.split()']);
  assert.equal(enclosing(undefined, 6, 'class TestRoutes:'), 'TestRoutes');
  assert.ok(isTestPath('testing/python/fixtures.py') && isTestPath('src/app.test.ts') && !isTestPath('src/flask/cli.py'));
  const removed = removedDefinitions(parseUnifiedDiff(['diff --git a/a.py b/a.py', '@@ -1,2 +1,1 @@', '-def helper_function(x):', '-    return x'].join('\n')));
  assert.deepEqual(removed.map(item => item.name), ['helper_function']);
});

test('diff facts: a line inserted into an existing test is a concern; a new test method is not', () => {
  const inserted = parseUnifiedDiff([
    'diff --git a/tests/test_cli.py b/tests/test_cli.py', '@@ -5,4 +5,9 @@ class TestRoutes:',
    '     def expect_order(self, order, output):', '         for expect, line in zip(order, output.splitlines()[2:]):', '+            line = line.lstrip()',
    '             assert line[: len(expect)] == expect', ' ', '+    def test_domain(self):', '+        assert True', '+',
    '     def test_simple(self):',
  ].join('\n'));
  const concerns = testConcerns(inserted[0]!, base['tests/test_cli.py']!.split('\n').slice(2));
  assert.deepEqual(concerns.map(concern => concern.label), ['lines inserted into existing test code in TestRoutes.expect_order (after base line 6)']);
  assert.deepEqual(concerns[0]!.detail, ['+ line = line.lstrip()']);
});

test('diff facts: a skip marker on an existing test is a concern; one inside a new test is not', () => {
  const skips = parseUnifiedDiff([
    'diff --git a/tests/test_a.py b/tests/test_a.py', '@@ -1,4 +1,10 @@',
    '+@pytest.mark.skip(reason="flaky")', ' def test_existing():', '     assert run() == 2', ' ',
    '+def test_new_skipif_behavior(testdir):', '+    testdir.makepyfile("""', '+        @pytest.mark.skipif("True")', '+        def test_x(): pass', '+    """)', '+',
    ' def test_other():', '     pass',
  ].join('\n'));
  const concerns = testConcerns(skips[0]!);
  assert.deepEqual(concerns.map(concern => concern.label), ['skip or xfail marker added at line 1']);
});

test('a rewritten existing assertion reaches the executive on the edit result; an added test does not', async t => {
  const { controller, board } = await fixture(t, {});
  const added = await edit(controller, 'tests/test_cli.py', '        assert 1 == 1\n', '        assert 1 == 1\n\n    def test_domain(self):\n        assert "Domain"\n');
  assert.equal(added.system1, undefined);
  assert.equal(board.frames, 0);
  const loosened = await controller.tool('replace_text', { path: 'tests/test_cli.py', oldText: 'assert line[: len(expect)] == expect', newText: 'assert expect in line.split()' }) as Reported;
  assert.equal(loosened.system1?.length, 1);
  assert.equal(loosened.system1![0]!.severity, 'error');
  assert.match(loosened.system1![0]!.summary, /^diff: unwarranted/);
  assert.match(loosened.system1![0]!.evidence!, /existing assertion changed in TestRoutes\.expect_order[\s\S]*- assert line\[: len\(expect\)\] == expect[\s\S]*\+ assert expect in line\.split\(\)/);
  assert.equal(seen.length, 1);
});

test('static facts are differential: a new syntax error or undefined name is reported, a pre-existing one is not', async t => {
  const { controller } = await fixture(t, {});
  const broken = await edit(controller, 'pkg/mod.py', 'return os.path.join(x, "a")', 'return os.path.join(x, "a"');
  assert.match(broken.system1![0]!.evidence!, /pkg\/mod\.py: SyntaxError/);
  const fixed = await controller.tool('replace_text', { path: 'pkg/mod.py', oldText: 'return os.path.join(x, "a"', newText: 'return os.path.join(x, sep)' }) as Reported;
  // legacy_global was undefined before the change; only `sep` is new.
  assert.equal(fixed.system1?.length, 1);
  assert.match(fixed.system1![0]!.evidence!, /undefined name sep at line 5/);
  assert.doesNotMatch(fixed.system1![0]!.evidence!, /legacy_global/);
  const clean = await controller.tool('replace_text', { path: 'pkg/mod.py', oldText: 'join(x, sep)', newText: 'join(x, os.sep)' }) as Reported;
  assert.equal(clean.system1, undefined);
  // The quiet state was restored, so the same problem is news again.
  const again = await controller.tool('replace_text', { path: 'pkg/mod.py', oldText: 'join(x, os.sep)', newText: 'join(x, sep)' }) as Reported;
  assert.match(again.system1![0]!.evidence!, /undefined name sep/);
});

test('removing a definition other files import is a concern', async t => {
  const { controller } = await fixture(t, {});
  const result = await edit(controller, 'pkg/mod.py', 'def helper_function(x):\n    return os.path.join(x, "a")\n', 'def _helper(x):\n    return os.path.join(x, "a")\n');
  const evidence = result.system1!.map(item => item.evidence).join('\n');
  assert.match(evidence, /top-level definition helper_function removed .* still referenced elsewhere/);
  assert.match(evidence, /pkg\/use\.py:1:from pkg\.mod import helper_function/);
});

test('the final gate re-raises an escalated concern still true of the final code, without a new evaluation', async t => {
  const { controller, board } = await fixture(t, {});
  await edit(controller, 'tests/test_cli.py', 'assert line[: len(expect)] == expect', 'assert expect in line');
  const frames = board.frames;
  const followUp = await controller.finalGate('Added the domain column. All tests pass.');
  assert.match(followUp!, /unresolved problems/);
  assert.match(followUp!, /Still true of your final code[\s\S]*You did not run run_checks[\s\S]*diff: unwarranted[\s\S]*existing assertion changed/);
  assert.equal(board.frames, frames);
});

test('a change the task warrants is not escalated; a resolved concern never reaches the final gate', async t => {
  const warranted = await fixture(t, {}, {}, 'Change the routes table to the new format.');
  const updated = await edit(warranted.controller, 'tests/test_cli.py', 'assert line[: len(expect)] == expect', 'assert expect in line');
  assert.equal(updated.system1, undefined);
  assert.equal(warranted.board.frames, 1);
  assert.equal(await warranted.controller.finalGate('Updated expect_order for the new format.'), undefined);

  const resolved = await fixture(t, {});
  await edit(resolved.controller, 'tests/test_cli.py', 'assert line[: len(expect)] == expect', 'assert expect in line');
  await resolved.controller.tool('replace_text', { path: 'tests/test_cli.py', oldText: 'assert expect in line', newText: 'assert line[: len(expect)] == expect' });
  const before = seen.length;
  assert.equal(await resolved.controller.finalGate('Done.'), undefined);
  assert.equal(seen.length, before);
});

test('ablations: escalate-all gates every concern without System 1, even a warranted one; deliver-none stays silent', async t => {
  const rules = await fixture(t, { appraiser: 'escalate-all' }, {}, 'Change the routes table to the new format.');
  const flagged = await edit(rules.controller, 'tests/test_cli.py', 'assert line[: len(expect)] == expect', 'assert expect in line');
  assert.equal(flagged.system1![0]!.severity, 'error');
  assert.match((await rules.controller.finalGate('Updated expect_order for the new format.'))!, /existing assertion changed/);
  assert.equal(rules.board.frames, 0);

  const silent = await fixture(t, { appraiser: 'deliver-none' });
  const quiet = await edit(silent.controller, 'tests/test_cli.py', 'assert line[: len(expect)] == expect', 'assert expect in line');
  assert.equal(quiet.system1, undefined);
  assert.equal(await silent.controller.finalGate('Done.'), undefined);
  assert.equal((await readFile(join(silent.root, 'tests/test_cli.py'), 'utf8')).includes('assert expect in line'), true);
});
