import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDashboard } from '../src/dashboard.js';
import { scrollTranscript } from '../src/scroll.js';
import type { DashboardState, HarnessEvent } from '../src/types.js';

const at = '2026-10-01T00:00:00.000Z';
const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function board(events: HarnessEvent[]): DashboardState {
  return { mode: 'LIVE', task: 'Build a notes app', workspace: '/tmp/notes', status: 'Working', executiveModel: 'openai/gpt-6.1-sol', system1Model: 'jev',
    view: 'spidermonkey', hz: 2, frames: 0, skipped: 0, reflexes: 0, escalations: 0, inputTokens: 0, lastLatencyMs: 0, probabilities: {}, events, answer: '' };
}

const finding = (summary: string, delivery: number, via: string, evidence?: string): HarnessEvent => ({ at, lane: 'system1', kind: 'escalation',
  message: `spidermonkey: ${summary}`, data: { monitor: 'spidermonkey', summary, delivery, via, ...(evidence ? { evidence } : {}) } });

test('findings delivered together form one System 1 block, indented under its title', () => {
  const state = board([
    { at, lane: 'executive', kind: 'prompt', message: 'Build a notes app' },
    finding('INTERRUPT · Stopped listening on :5173 (node)', 1, 'run_command'),
    finding('1 new kind of line in logs/qa-bot.log', 1, 'run_command', 'qa: GET /api/notes -> connection refused'),
    finding('Process exited: node storage', 2, 'wake'),
    { at, lane: 'executive', kind: 'reasoning', message: '**Checking the server**\n\nThe app stopped listening; I will read its log.' },
  ]);
  const screen = plain(renderDashboard(state, 180, 40));
  assert.equal(screen.match(/SYSTEM 1 →/g)?.length, 1, screen);
  assert.match(screen, /SYSTEM 1 → 2 findings injected into the run_command result/);
  assert.match(screen, / {2}▌ {2}⚡ INTERRUPT · Stopped listening on :5173/);
  assert.match(screen, / {2}▌ {2}⚑ 1 new kind of line/);
  assert.match(screen, / {2}▌ {6}qa: GET \/api\/notes/);
  assert.doesNotMatch(screen, /Process exited: node storage/, 'a wake shows as the prompt it became');
  assert.match(screen, /THINKING · reasoning summary/);
  assert.match(screen, /┊ Checking the server/);
});

test('the transcript scrolls back and returns to following new output', () => {
  const events: HarnessEvent[] = Array.from({ length: 60 }, (_, index) => ({ at, lane: 'executive', kind: 'message', message: `reply ${index}` }));
  const state = board(events);
  state.scroll = { max: 0 };
  let screen = plain(renderDashboard(state, 180, 30));
  assert.match(screen, /reply 59/);
  assert.ok(state.scroll.max > 0);
  assert.match(screen, /↑↓ PgUp PgDn scroll/);
  scrollTranscript(state, 'top');
  screen = plain(renderDashboard(state, 180, 30));
  assert.match(screen, /reply 0\b/);
  assert.doesNotMatch(screen, /reply 59/);
  assert.match(screen, /more lines · End follows/);
  scrollTranscript(state, 10_000);
  assert.equal(state.scroll.top, undefined, 'scrolling past the end follows again');
  screen = plain(renderDashboard(state, 180, 30));
  assert.match(screen, /reply 59/);
});
