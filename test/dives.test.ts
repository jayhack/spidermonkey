import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Controller } from '../src/controller.js';
import type { Question, S1Evaluate } from '../src/monitor.js';
import { CodeIndex } from '../src/monitors/dives.js';
import type { DashboardState } from '../src/types.js';
import { Workspace } from '../src/workspace.js';

const task = 'Cart.total returns 0 when no discount code is given: apply_discount multiplies the amount by the rate instead of subtracting the discount.';

function state(root: string): DashboardState {
  return { mode: 'test', task, workspace: root, status: 'Working', executiveModel: 'test', system1Model: 'test', hz: 2,
    frames: 0, skipped: 0, reflexes: 0, escalations: 0, inputTokens: 0, lastLatencyMs: 0, probabilities: {}, events: [], answer: '' };
}

const cart = `from .pricing import apply_discount


class Cart:
    def __init__(self):
        self.items = []

    def add(self, price):
        self.items.append(price)

    def total(self, code=None):
        subtotal = sum(self.items)
        return apply_discount(subtotal, code)
`;
const pricing = `RATES = {"HALF": 0.5}


def apply_discount(amount, code):
    rate = RATES.get(code, 0)
    return amount * rate
`;
const pricingTest = `from src.pricing import apply_discount


def test_apply_discount_half():
    assert apply_discount(10, "HALF") == 5
`;

type Seen = { candidates: Array<{ id: string; view: string; relation: string }>; questions: Record<string, Question> };

/** Scripted System 1: follow with P(follow), and favor candidates whose label matches `want`. */
function scripted(follow: number, want: RegExp, seen: Seen[]): S1Evaluate {
  return async (s1State, questions) => {
    const candidates = (s1State as Seen).candidates;
    seen.push({ candidates, questions });
    return { inputTokens: 20, costUsd: 0.0001, answers: {
      follow: { type: 'boolean', probability: follow },
      ...Object.fromEntries(candidates.map(candidate => [candidate.id, { type: 'boolean', probability: want.test(candidate.view) ? 0.9 : 0.1 }])),
    } };
  };
}

async function fixture(t: TestContext, dives: Record<string, unknown>, s1: S1Evaluate) {
  const root = await mkdtemp(join(tmpdir(), 'ros-dives-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'src/cart.py'), cart);
  await writeFile(join(root, 'src/pricing.py'), pricing);
  await writeFile(join(root, 'tests/test_pricing.py'), pricingTest);
  const board = state(root);
  const controller = new Controller(new Workspace(root, 'exit 0'), board, async () => { throw new Error('legacy classifier must not run'); },
    undefined, 0.85, { enabled: true, continuous: false, monitors: { dives } }, undefined, s1);
  t.after(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });
  return { controller, board };
}

type Result = { result: Record<string, unknown> & { system1Dive?: { note: string; views: string } } };

test('a search dives into the enclosing definition, then the called definition; delivered views count as read', async t => {
  const seen: Seen[] = [];
  const { controller, board } = await fixture(t, { hops: 2, minViewLines: 1 }, scripted(0.9, /cart\.py.*total|pricing\.py.*apply_discount/, seen));
  const found = await controller.tool('search', { query: 'def total' }) as Result;
  // The executive's own result is untouched; the dive rides along.
  assert.equal((found.result.matches as unknown[]).length, 1);
  const views = found.result.system1Dive!.views;
  assert.match(views, /^--- src\/cart\.py lines 11-13 \(Cart\.total; hop 1; definition of `total` \(search hit at line 11\); System 1 P=0\.90\)/);
  assert.match(views, /--- src\/pricing\.py lines 4-6 \(apply_discount; hop 2; definition of `apply_discount`, called 1x in src\/cart\.py lines 11-13; System 1 P=0\.90\)\ndef apply_discount/);
  assert.match(found.result.system1Dive!.note, /count as read/);
  assert.equal(board.frames, 2);
  // Candidate relations are observed facts; the question marks file text as untrusted.
  assert.match(String(seen[0]!.questions.c0!.instructions), /untrusted evidence/);
  // No read_file: the dive authorized the edit.
  const edit = await controller.tool('replace_text', { path: 'src/pricing.py', oldText: 'amount * rate', newText: 'amount * (1 - rate)' }) as Result;
  assert.equal(edit.result.written, true);
  assert.ok(board.events.some(event => event.kind === 'dive-used' && event.data?.path === 'src/pricing.py' && event.data?.hop === 2));
});

test('System 1 can decline to follow; the result is unchanged and only one evaluation is spent', async t => {
  const { controller, board } = await fixture(t, {}, scripted(0.1, /./, []));
  const found = await controller.tool('search', { query: 'def total' }) as Result;
  assert.equal(found.result.system1Dive, undefined);
  assert.equal(board.frames, 1);
  const decision = board.events.find(event => event.kind === 'dive')!;
  assert.equal(decision.data?.stopped, 'not worth following');
});

test('the lexical ablation follows the top ordinary-code candidate without the decision model', async t => {
  const { controller, board } = await fixture(t, { mode: 'lexical', hops: 1, minViewLines: 1 }, async () => { throw new Error('System 1 must not run'); });
  const read = await controller.tool('read_file', { path: 'src/cart.py' }) as Result;
  assert.match(read.result.system1Dive!.views, /--- src\/pricing\.py lines 4-6 \(apply_discount; hop 1; definition of `apply_discount`.*selected by the lexical rule\)/);
  assert.equal(board.frames, 0);
});

test('views the executive already read are not offered again, and the character budget holds', async t => {
  const seen: Seen[] = [];
  const { controller } = await fixture(t, { hops: 1, maxChars: 260 }, scripted(0.9, /./, seen));
  await controller.tool('read_file', { path: 'src/pricing.py' });
  const found = await controller.tool('search', { query: 'apply_discount' }) as Result;
  const offered = seen.flatMap(call => call.candidates.map(candidate => candidate.view));
  assert.ok(!offered.some(view => view.startsWith('src/pricing.py')), offered.join('\n'));
  const views = found.result.system1Dive!.views;
  const body = views.split('\n').slice(1).join('\n');
  assert.ok(body.length <= 260, `delivered ${body.length} characters`);
});

test('short definitions are delivered as a screenful with their surroundings; the preview starts at the definition', async t => {
  const seen: Seen[] = [];
  const { controller } = await fixture(t, { hops: 1, minViewLines: 30 }, scripted(0.9, /pricing\.py/, seen));
  const found = await controller.tool('search', { query: 'def apply_discount' }) as Result;
  assert.match(found.result.system1Dive!.views, /^--- src\/pricing\.py lines 1-7 \(apply_discount at lines 4-6, with surrounding lines; hop 1; definition of `apply_discount`/);
  assert.match(found.result.system1Dive!.views, /RATES = \{"HALF": 0\.5\}/);
  const offered = seen[0]!.candidates.find(candidate => candidate.view.startsWith('src/pricing.py')) as unknown as { preview: string };
  assert.match(offered.preview, /^def apply_discount/);
});

test('off mode records candidates but never delivers or evaluates', async t => {
  const { controller, board } = await fixture(t, { mode: 'off' }, async () => { throw new Error('System 1 must not run'); });
  const read = await controller.tool('read_file', { path: 'src/cart.py' }) as Result;
  assert.equal(read.result.system1Dive, undefined);
  const recorded = board.events.find(event => event.kind === 'dive')!;
  assert.ok((recorded.data?.candidates as unknown[]).length > 0);
  // Without a dive the file is not authorized for edits.
  const edit = await controller.tool('replace_text', { path: 'src/pricing.py', oldText: 'amount * rate', newText: 'amount' }) as Result;
  assert.match(String(edit.result.error), /Read the file before editing/);
});

test('the definition index spans multi-line signatures, decorators, and brace bodies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ros-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.py'), '@decorator\ndef f(\n    a,\n    b,\n):\n    return a\n\n\ndef g(): return 1\nx = 1\n');
  await writeFile(join(root, 'b.ts'), 'export function h(a: number) {\n  if (a) {\n    return 1;\n  }\n  return 2;\n}\nconst y = 1;\n');
  const index = new CodeIndex(new Workspace(root));
  await index.ensure();
  assert.deepEqual(index.definitions('f').map(def => [def.start, def.end]), [[1, 6]]);
  assert.deepEqual(index.definitions('g').map(def => [def.start, def.end]), [[9, 9]]);
  assert.deepEqual(index.definitions('h').map(def => [def.start, def.end]), [[1, 6]]);
});
