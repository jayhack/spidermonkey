import {
  C, H, W, chip, circle, clamp, cool, drawLine, during, easeInOut, easeOut, glow, hatch, lerp, line, measure,
  mix, noise, rect, seg, text, wrap, type Ctx,
} from './kit';
import { captions } from './script';

// One frame of the explainer at time t (seconds). The executive agent works on the left; the
// machine's processes fill the right. A human-mind diagram briefly explains the two systems,
// then its perception band becomes the decision model that sits on top of the machine and
// escalates what matters to the agent.

const polar = (x: number, y: number, r: number, a: number): [number, number] => [x + r * Math.cos(a), y + r * Math.sin(a)];

// ── Layout ──────────────────────────────────────────────────────────────────────────────────────

const PANEL = { x: 80, y: 96, w: 620, h: 650 };
const ICON = { x: PANEL.x + 38, y: PANEL.y + 42, r: 13 };
const LINES = { x: PANEL.x + 30, top: PANEL.y + 116, height: 34, visible: 15 };
const GRID = { label: 790, x0: 1004, x1: 1520, top: 318, row: 34, cell: 11, pitch: 15, step: 0.25 };
const COLUMNS = Math.floor((GRID.x1 - GRID.x0) / GRID.pitch);
const ROWS = ['notes-server :5173', 'storage :5174', 'node --test', 'qa-bot', 'Google Chrome', 'Chrome Helper', 'Slack', 'Spotify',
  'Docker', 'postgres', 'kernel_task', 'WindowServer'];
const rowY = (i: number) => GRID.top + i * GRID.row;
const JEV = { x: 1262, y: 176, rIn: 30, rOut: 44 };
const MIND = { x: 800, y: 420, rIn: 62, rOut: 86, core: 34 };

// ── The story's events ──────────────────────────────────────────────────────────────────────────

/** Storage crashes twice: unnoticed at 11.6, caught by the decision model at 23.6. */
function storageState(ts: number): 'up' | 'crash' | 'down' {
  if ((ts >= 11.6 && ts < 12.1) || (ts >= 23.6 && ts < 24.1)) return 'crash';
  if ((ts >= 12.1 && ts < 20.0) || ts >= 24.1) return 'down';
  return 'up';
}
const CUT = 25.9;
const testsRunning = (ts: number) => (ts >= 7.4 && ts < CUT) || (ts >= 2.9 && ts < 3.5) || (ts >= 28.1 && ts < 28.7);

const TARGETS = {
  logs: { x: 1330, y: 206, label: 'logs/server.log' },
  server: { x: 930, y: 262, label: 'dev server :5173' },
  tests: { x: 1210, y: 392, label: 'tests' },
  storage: { x: 1000, y: 478, label: 'storage :5174' },
  memory: { x: 1390, y: 560, label: 'memory' },
  apps: { x: 880, y: 620, label: 'other apps' },
} as const;
type Entry = { at: number; kind: 'prompt' | 'tool' | 'result' | 'wait' | 'inject'; text: string; poll?: keyof typeof TARGETS };
const TRANSCRIPT: Entry[] = [
  { at: 0.4, kind: 'prompt', text: 'Add a notes API backed by the storage service' },
  { at: 1.2, kind: 'tool', text: 'Read server.js' },
  { at: 2.0, kind: 'tool', text: 'Edit server.js  +24 −3' },
  { at: 2.8, kind: 'tool', text: 'Bash npm test' },
  { at: 3.5, kind: 'result', text: '12 passed' },
  { at: 5.0, kind: 'tool', text: 'Bash tail -n 50 logs/server.log', poll: 'logs' },
  { at: 5.8, kind: 'tool', text: 'Bash curl localhost:5173/health', poll: 'server' },
  { at: 6.6, kind: 'tool', text: 'Bash ps aux | grep storage', poll: 'storage' },
  { at: 7.4, kind: 'tool', text: 'Bash npm test', poll: 'tests' },
  { at: 7.9, kind: 'wait', text: '' },
  { at: CUT + 0.1, kind: 'inject', text: 'System 1 · storage :5174 exited' },
  { at: CUT + 0.3, kind: 'inject', text: 'tests can’t pass; stopped npm test' },
  { at: 26.8, kind: 'tool', text: 'Read logs/storage.log' },
  { at: 27.5, kind: 'tool', text: 'Edit server.js  retry, 503 on outage' },
  { at: 28.1, kind: 'tool', text: 'Bash npm test' },
  { at: 28.7, kind: 'result', text: '14 passed' },
];
const FRAMES = Array.from({ length: 13 }, (_, i) => 20 + i);

// ── Poses: the executive's core and the perception band move between places ────────────────────

function corePose(t: number) {
  const out = easeInOut(seg(t, 13.7, 14.5));
  const back = easeInOut(seg(t, 18.8, 19.9));
  const k = out * (1 - back);
  return { x: lerp(ICON.x, MIND.x, k), y: lerp(ICON.y, MIND.y, k), r: lerp(ICON.r, MIND.core, k) };
}

function bandPose(t: number) {
  const k = easeInOut(seg(t, 18.9, 20.2));
  return { x: lerp(MIND.x, JEV.x, k), y: lerp(MIND.y, JEV.y, k), rIn: lerp(MIND.rIn, JEV.rIn, k), rOut: lerp(MIND.rOut, JEV.rOut, k),
    alpha: seg(t, 14.0, 14.6), sweep: easeOut(seg(t, 14.0, 15.0)) };
}

/** How far the scene recedes while the mind diagram is on screen. */
const recede = (t: number) => 0.9 * during(t, 13.6, 19.4, 0.6);

// ── Drawing pieces ──────────────────────────────────────────────────────────────────────────────

function core(ctx: Ctx, t: number, a: number) {
  const pose = corePose(t);
  const rings = pose.r > 20 ? 4 : 2;
  for (let ring = 0; ring < rings; ring++) {
    circle(ctx, pose.x, pose.y, pose.r * (1 - ring * (0.8 / rings)), { color: mix(C.sky, C.ink, ring * 0.15), width: 1.6, alpha: a });
  }
  circle(ctx, pose.x, pose.y, Math.max(2.5, pose.r * 0.14), { fill: C.sky, alpha: a });
  // The slow beat of deliberate thought.
  const beat = (t % 2.4) / 2.4;
  circle(ctx, pose.x, pose.y, pose.r + pose.r * 0.7 * easeOut(beat), { color: C.sky, width: 1.2, alpha: a * (1 - beat) * 0.45 });
}

/** A burst of rings on the executive's core: something arrived. */
function coreBurst(ctx: Ctx, t: number, at: number, color: string) {
  const k = seg(t, at, at + 1.4);
  if (k <= 0 || k >= 1) return;
  const pose = corePose(t);
  for (let ring = 0; ring < 3; ring++) {
    const q = clamp(k * 1.25 - ring * 0.12);
    if (q > 0) circle(ctx, pose.x, pose.y, pose.r + 46 * easeOut(q), { color, width: 2.2 - ring * 0.5, alpha: (1 - q) * (0.9 - ring * 0.2) });
  }
}

interface Flash { color: string; k: number }

/** The fast clock: System 1 in the mind, then the decision model on the machine. */
function band(ctx: Ctx, t: number, flashes: Flash[]) {
  const pose = bandPose(t);
  if (pose.alpha <= 0) return;
  const ticks = 56;
  const head = (t * 0.9) % 1;
  circle(ctx, pose.x, pose.y, pose.rIn - 5, { color: C.faint, width: 1, alpha: pose.alpha }, 0, pose.sweep);
  circle(ctx, pose.x, pose.y, pose.rOut + 5, { color: C.faint, width: 1, alpha: pose.alpha }, 0, pose.sweep);
  let color: string = C.orange;
  for (const flash of flashes) color = mix(color, flash.color, flash.k);
  for (let i = 0; i < ticks; i++) {
    if (i / ticks > pose.sweep) break;
    const angle = (i / ticks) * Math.PI * 2 - Math.PI / 2;
    const bright = Math.exp(-((head - i / ticks + 1) % 1) * 7);
    const [x1, y1] = polar(pose.x, pose.y, pose.rIn, angle);
    const [x2, y2] = polar(pose.x, pose.y, pose.rOut, angle);
    line(ctx, x1, y1, x2, y2, { color, width: 2, alpha: pose.alpha * (0.18 + 0.82 * bright) });
  }
  circle(ctx, pose.x, pose.y, 4.5, { fill: color, alpha: pose.alpha * seg(t, 19.6, 20.2) });
}

// ── The agent ───────────────────────────────────────────────────────────────────────────────────

/** Lines scrolled off the top so far, eased as each new line arrives. */
function scrolled(t: number) {
  let offset = 0;
  TRANSCRIPT.forEach((entry, index) => { if (index >= LINES.visible) offset += easeOut(seg(t, entry.at, entry.at + 0.35)); });
  return offset;
}

const WAIT = TRANSCRIPT.findIndex(entry => entry.kind === 'wait');
const lineY = (t: number, index: number) => LINES.top + (index - scrolled(t)) * LINES.height;

function agent(ctx: Ctx, t: number, a: number) {
  if (a <= 0) return;
  rect(ctx, PANEL.x, PANEL.y, PANEL.w, PANEL.h, { color: C.faint, width: 1.25, alpha: a, radius: 6 });
  text(ctx, 'Executive', ICON.x + 30, ICON.y + 8, { size: 22, weight: 800, color: C.sky, alpha: a, tracking: -0.4 });
  text(ctx, 'coding agent · GPT-6.1 Sol', PANEL.x + PANEL.w - 26, ICON.y + 7, { size: 14, mono: true, color: C.soft, alpha: a, align: 'right' });
  line(ctx, PANEL.x, PANEL.y + 78, PANEL.x + PANEL.w, PANEL.y + 78, { color: C.faint, width: 1, alpha: a });
  ctx.save();
  ctx.beginPath();
  ctx.rect(PANEL.x, PANEL.y + 82, PANEL.w, PANEL.h - 86);
  ctx.clip();
  let injectTop: number | undefined;
  TRANSCRIPT.forEach((entry, index) => {
    if (t < entry.at) return;
    const y = lineY(t, index);
    const la = a * seg(t, entry.at, entry.at + 0.25) * clamp((y - (LINES.top - LINES.height)) / LINES.height);
    if (la <= 0) return;
    const x = LINES.x + 8 * (1 - easeOut(seg(t, entry.at, entry.at + 0.25)));
    if (entry.kind === 'prompt') {
      text(ctx, '›', x, y, { size: 17, mono: true, color: C.soft, alpha: la });
      text(ctx, entry.text, x + 22, y, { size: 17, color: C.paper, alpha: la, weight: 500 });
    } else if (entry.kind === 'tool') {
      const [name, ...rest] = entry.text.split(' ');
      circle(ctx, x + 5, y - 6, 4.5, { fill: C.sky, alpha: la });
      text(ctx, name!, x + 22, y, { size: 17, mono: true, weight: 700, color: C.paper, alpha: la });
      text(ctx, rest.join(' '), x + 22 + measure(ctx, `${name} `, { size: 17, mono: true, weight: 700 }), y, { size: 17, mono: true, color: C.soft, alpha: la });
    } else if (entry.kind === 'result') {
      text(ctx, '⎿', x + 22, y, { size: 17, mono: true, color: C.muted, alpha: la });
      text(ctx, entry.text, x + 46, y, { size: 17, mono: true, color: C.blue300, alpha: la });
    } else if (entry.kind === 'wait') {
      text(ctx, '⎿', x + 22, y, { size: 17, mono: true, color: C.muted, alpha: la });
      const width = Math.min(330, (Math.min(t, CUT) - entry.at) * 24);
      rect(ctx, x + 46, y - 14, width, 17, { color: C.muted, width: 1.2, alpha: la, radius: 2 });
      hatch(ctx, x + 46, y - 14, width, 17, C.muted, la * 0.7, 8);
      if (t < CUT) text(ctx, 'waiting…', x + 56 + width, y, { size: 15, mono: true, color: C.soft, alpha: la });
      else {
        line(ctx, x + 46 + width, y - 18, x + 46 + width, y + 7, { color: C.hot, width: 3, alpha: la });
        text(ctx, 'stopped early', x + 58 + width, y, { size: 15, mono: true, weight: 600, color: C.hot, alpha: la });
      }
    } else {
      injectTop ??= y - 22;
      text(ctx, entry.text, x + 22, y, { size: 17, mono: true, weight: entry.text.startsWith('System 1') ? 700 : 400, color: C.orange, alpha: la });
    }
  });
  if (injectTop !== undefined) rect(ctx, LINES.x + 2, injectTop, 4, LINES.height * 2 - 4, { fill: C.orange, alpha: a * seg(t, CUT + 0.1, CUT + 0.4), radius: 1 });
  ctx.restore();
}

// ── Beat 2: everything the agent has to poll ────────────────────────────────────────────────────

function targets(ctx: Ctx, t: number) {
  const a = seg(t, 4.9, 5.4) * (1 - seg(t, 9.4, 10.4));
  if (a <= 0) return;
  const polled = new Map(TRANSCRIPT.filter(entry => entry.poll).map(entry => [entry.poll!, entry]));
  (Object.keys(TARGETS) as Array<keyof typeof TARGETS>).forEach((key, index) => {
    const target = TARGETS[key];
    const la = a * seg(t, 4.9 + index * 0.12, 5.3 + index * 0.12);
    const entry = polled.get(key);
    const lit = entry ? during(t, entry.at, entry.at + 0.9, 0.15) : 0;
    const seen = entry !== undefined && t >= entry.at;
    if (entry && seen) {
      const y = lineY(t, TRANSCRIPT.indexOf(entry)) - 6;
      drawLine(ctx, PANEL.x + PANEL.w, y, target.x - 12, target.y - 5, easeOut(seg(t, entry.at, entry.at + 0.35)),
        { color: mix(C.guide, C.sky, lit), width: 1.3, alpha: la, dash: [4, 5] });
    }
    circle(ctx, target.x - 12, target.y - 5, 4, { fill: seen ? mix(C.blue, C.sky, lit) : C.muted, alpha: la });
    text(ctx, target.label, target.x, target.y, { size: 16, mono: true, color: seen ? mix(C.soft, C.sky, lit) : C.muted, alpha: la });
  });
}

// ── The machine ─────────────────────────────────────────────────────────────────────────────────

function sample(row: number, k: number): { level: number; state: 'up' | 'crash' | 'down' } {
  const ts = k * GRID.step;
  const n = noise(k, 10 + row);
  switch (row) {
    case 0: return { level: 0.3 + 0.3 * n + (k % 10 === 0 ? 0.3 : 0), state: 'up' };
    case 1: return { level: 0.18 + 0.22 * n, state: storageState(ts) };
    case 2: return { level: testsRunning(ts) ? 0.8 + 0.18 * n : 0.03, state: 'up' };
    case 3: return { level: k % 10 < 2 ? 0.75 : 0.1 + 0.1 * n, state: 'up' };
    case 4: return { level: 0.45 + 0.45 * n, state: 'up' };
    case 5: return { level: 0.25 + 0.5 * noise(k, 40), state: 'up' };
    case 6: return { level: 0.12 + 0.15 * n, state: 'up' };
    case 7: return { level: 0.25 + 0.12 * Math.sin(k * 0.35), state: 'up' };
    case 8: return { level: 0.2 + 0.35 * noise(Math.floor(k / 6), 41), state: 'up' };
    case 9: return { level: 0.08 + 0.3 * (n > 0.8 ? 1 : 0), state: 'up' };
    case 10: return { level: 0.25 + 0.2 * n, state: 'up' };
    default: return { level: 0.35 + 0.3 * n, state: 'up' };
  }
}

function cellFill(row: number, k: number) {
  const { level, state } = sample(row, k);
  if (state === 'crash') return mix(C.hot, C.amber, noise(k, 99) * 0.5);
  if (state === 'down') return undefined;
  return cool(level);
}

function sampleX(t: number, k: number) {
  const now = Math.floor(t / GRID.step);
  return GRID.x0 + (COLUMNS - 1 - (now - k)) * GRID.pitch - (t / GRID.step - now) * GRID.pitch;
}

function machine(ctx: Ctx, t: number, a: number) {
  if (a <= 0) return;
  const now = Math.floor(t / GRID.step);
  const frac = t / GRID.step - now;
  for (let row = 0; row < ROWS.length; row++) {
    const ra = a * seg(t, 9.6 + row * 0.06, 10.4 + row * 0.06);
    if (ra <= 0) continue;
    const y = rowY(row);
    text(ctx, ROWS[row]!, GRID.label, y + 5, { size: 14, mono: true, color: C.soft, alpha: ra });
    // Newest sample at the right; one extra column slides out at the left.
    for (let back = 0; back <= COLUMNS; back++) {
      const k = now - back;
      const x = sampleX(t, k);
      const edge = clamp((x - (GRID.x0 - GRID.pitch)) / GRID.pitch) * (back === 0 ? clamp(frac * 4) : 1);
      if (edge <= 0) continue;
      const fill = cellFill(row, k);
      if (fill) rect(ctx, x, y - GRID.cell / 2, GRID.cell, GRID.cell, { fill, alpha: ra * edge, radius: 2 });
      else rect(ctx, x + 0.75, y - GRID.cell / 2 + 0.75, GRID.cell - 1.5, GRID.cell - 1.5, { color: C.faint, width: 1, alpha: ra * edge, radius: 2 });
    }
  }
  const axis = a * seg(t, 10, 10.8);
  const bottom = rowY(ROWS.length - 1) + 24;
  line(ctx, GRID.x0, bottom, GRID.x1, bottom, { color: C.guide, width: 1, alpha: axis });
  text(ctx, 'time →', GRID.x1, bottom + 20, { size: 13, mono: true, color: C.muted, alpha: axis, align: 'right' });
  for (const at of [11.6, 23.6]) {
    text(ctx, 'storage: FATAL segment corrupt; exiting', GRID.x1, GRID.top - 26, { size: 14, mono: true, color: C.hot, alpha: a * during(t, at, at + 2.6, 0.25), align: 'right' });
  }
}

/** The first crash's signal never reaches the agent. */
function unnoticed(ctx: Ctx, t: number) {
  const k = seg(t, 11.8, 12.8);
  const a = 1 - seg(t, 12.8, 13.5);
  if (k <= 0 || a <= 0) return;
  const from: [number, number] = [GRID.label - 14, rowY(1) - 5];
  const to: [number, number] = [PANEL.x + PANEL.w + 8, lineY(t, WAIT) - 6];
  const reach = 0.6 * easeOut(k);
  drawLine(ctx, from[0], from[1], to[0], to[1], reach, { color: C.hot, width: 1.5, alpha: a * 0.8, dash: [4, 5] });
  const x = lerp(from[0], to[0], reach);
  const y = lerp(from[1], to[1], reach);
  const mark = a * seg(t, 12.4, 12.7);
  line(ctx, x - 6, y - 6, x + 6, y + 6, { color: C.hot, width: 2, alpha: mark });
  line(ctx, x - 6, y + 6, x + 6, y - 6, { color: C.hot, width: 2, alpha: mark });
}

// ── Beat 4: the mind ────────────────────────────────────────────────────────────────────────────

function mindLabels(ctx: Ctx, t: number) {
  const a = during(t, 14.3, 18.9, 0.5);
  if (a <= 0) return;
  text(ctx, 'executive function', MIND.x - 112, MIND.y + 4, { size: 26, weight: 800, color: C.sky, alpha: a, align: 'right', tracking: -0.5 });
  text(ctx, 'plans, decides, acts', MIND.x - 112, MIND.y + 32, { size: 17, color: C.soft, alpha: a, align: 'right' });
  const b = during(t, 15.0, 18.9, 0.5);
  text(ctx, 'perception', MIND.x + 112, MIND.y + 4, { size: 26, weight: 800, color: C.orange, alpha: b, tracking: -0.5 });
  text(ctx, 'watches everything, makes snap judgments', MIND.x + 112, MIND.y + 32, { size: 17, color: C.soft, alpha: b });
}

// ── Beats 5–6: the decision model on top of the machine ─────────────────────────────────────────

function decisionModel(ctx: Ctx, t: number, a: number) {
  const la = a * seg(t, 19.8, 20.4);
  text(ctx, 'Decision model', JEV.x + 66, JEV.y - 2, { size: 22, weight: 800, color: C.orange, alpha: la, tracking: -0.4 });
  text(ctx, 'Jev · fast, cheap, always on', JEV.x + 66, JEV.y + 22, { size: 14, mono: true, color: C.soft, alpha: la });
  // Frames of the machine rise into it.
  for (const at of FRAMES) {
    const p = seg(t, at, at + 0.55);
    if (p <= 0 || p >= 1) continue;
    const q = easeInOut(p);
    const k = Math.floor(at / GRID.step);
    for (let row = 0; row < ROWS.length; row++) {
      const size = GRID.cell * (1 - 0.7 * q);
      const x = lerp(sampleX(at, k) + GRID.cell / 2, JEV.x, q);
      const y = lerp(rowY(row), JEV.y, q);
      rect(ctx, x - size / 2, y - size / 2, size, size, { fill: cellFill(row, k) ?? C.faint, alpha: a * (at < 24.5 ? 0.85 : 0.45) * (1 - 0.6 * q), radius: 2 });
    }
  }
  // What it concluded.
  const readouts = [
    { from: 21.0, to: 22.1, text: 'Chrome +80 MB → ignore', color: C.muted },
    { from: 22.2, to: 23.3, text: 'qa-bot · 40 × GET 200 → ignore', color: C.muted },
    { from: 24.6, to: 26.6, text: 'storage :5174 exited · urgency 2.8 → escalate', color: C.hot },
  ];
  for (const readout of readouts) {
    text(ctx, readout.text, JEV.x, 266, { size: 15, mono: true, weight: readout.color === C.hot ? 600 : 400, color: readout.color, alpha: a * during(t, readout.from, readout.to, 0.2), align: 'center' });
  }
}

/** The escalation arcs over the machine into the agent's transcript. */
function escalation(ctx: Ctx, t: number) {
  const p = seg(t, 25.0, CUT);
  const fade = 1 - seg(t, CUT, CUT + 0.6);
  if (p <= 0 || fade <= 0) return;
  const from: [number, number] = [JEV.x - 40, JEV.y];
  const control: [number, number] = [900, 60];
  const to: [number, number] = [PANEL.x + PANEL.w - 12, lineY(t, WAIT) - 6];
  const at = (k: number): [number, number] => [
    (1 - k) * (1 - k) * from[0] + 2 * (1 - k) * k * control[0] + k * k * to[0],
    (1 - k) * (1 - k) * from[1] + 2 * (1 - k) * k * control[1] + k * k * to[1],
  ];
  const q = easeInOut(p);
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.strokeStyle = C.hot;
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  for (let step = 0; step <= 40; step++) {
    const [x, y] = at((step / 40) * q);
    if (step === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
  const [x, y] = at(q);
  glow(ctx, x, y, 28, C.hot, fade);
  circle(ctx, x, y, 5.5, { fill: C.hot, alpha: fade });
  if (p < 1) chip(ctx, 'INTERRUPT · storage exited', x, y - 18, { color: C.hot, size: 14, alpha: fade, align: 'center' });
}

// ── Beat 7: the result ──────────────────────────────────────────────────────────────────────────

function result(ctx: Ctx, t: number) {
  const a = seg(t, 28.6, 29.2);
  if (a <= 0) return;
  const x = GRID.label;
  text(ctx, 'hung test runs · GPT-6.1 Sol', x, 372, { size: 16, weight: 600, color: C.soft, alpha: a });
  const scale = 5.2;
  const long = 90 * scale * easeOut(seg(t, 28.8, 29.8));
  text(ctx, 'agent alone', x, 432, { size: 17, color: C.soft, alpha: a });
  rect(ctx, x + 210, 416, long, 20, { color: C.muted, width: 1.2, alpha: a, radius: 2 });
  hatch(ctx, x + 210, 416, long, 20, C.muted, a * 0.7, 8);
  text(ctx, '90 s', x + 222 + long, 432, { size: 17, mono: true, color: C.paper, alpha: a * seg(t, 29.6, 29.9) });
  const b = seg(t, 29.4, 29.9);
  const short = 15 * scale * easeOut(seg(t, 29.5, 30.0));
  text(ctx, 'with Spidermonkey', x, 488, { size: 17, weight: 700, color: C.orange, alpha: b });
  rect(ctx, x + 210, 472, short, 20, { fill: C.orange, alpha: b, radius: 2 });
  text(ctx, '15 s', x + 222 + short, 488, { size: 17, mono: true, weight: 700, color: C.amber, alpha: b * seg(t, 29.9, 30.2) });
  const c = seg(t, 30.2, 30.7);
  text(ctx, '−54% time on hang tasks · 0 false interrupts', x, 540, { size: 14, mono: true, color: C.muted, alpha: c });
  text(ctx, 'System 1 costs $0.003 beside $0.20 for the agent', x, 564, { size: 14, mono: true, color: C.muted, alpha: c });
  const d = seg(t, 30.9, 31.6);
  text(ctx, 'Spidermonkey', x, 668, { size: 46, weight: 800, color: C.paper, alpha: d, tracking: -1.4 });
  text(ctx, 'an always-on System 1 for coding agents', x, 704, { size: 19, color: C.soft, alpha: d });
}

function caption(ctx: Ctx, t: number) {
  for (const entry of captions) {
    const a = during(t, entry.from, entry.to, 0.3);
    if (a <= 0) continue;
    const lines = wrap(ctx, entry.text, 1400, { size: 30, weight: 500 });
    lines.forEach((value, index) => {
      text(ctx, value, 80, 846 - (lines.length - 1 - index) * 42, { size: 30, weight: 500, color: C.paper, alpha: a });
    });
  }
}

// ── The frame ───────────────────────────────────────────────────────────────────────────────────

/** Draw the frame at t. Narrow players show captions as page text instead of in the frame. */
export function render(ctx: Ctx, t: number, options: { captions?: boolean } = {}) {
  ctx.save();
  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, W, H);
  const back = 1 - recede(t);
  const panel = seg(t, 0, 0.5);

  agent(ctx, t, panel * back);
  targets(ctx, t);
  machine(ctx, t, back * (1 - seg(t, 28.4, 29.0)));
  unnoticed(ctx, t);
  if (t > 19.5) decisionModel(ctx, t, back * (1 - 0.6 * seg(t, 28.4, 29.0)));
  escalation(ctx, t);
  result(ctx, t);

  // The executive's core and the perception band, wherever they are.
  const flashes: Flash[] = [
    { color: C.hot, k: during(t, 24.4, 25.8, 0.2) },
    { color: C.muted, k: 0.5 * (during(t, 21.0, 22.0, 0.2) + during(t, 22.2, 23.2, 0.2)) },
  ];
  // A clear ground for the mind diagram while it is on screen.
  const mind = bandPose(t);
  circle(ctx, mind.x, mind.y, mind.rOut + 14, { fill: C.ink, alpha: during(t, 13.8, 19.6, 0.6) * (1 - seg(t, 18.9, 19.6)) });
  band(ctx, t, flashes);
  core(ctx, t, panel);
  coreBurst(ctx, t, CUT, C.hot);
  mindLabels(ctx, t);

  if (options.captions !== false) caption(ctx, t);
  ctx.restore();
}
