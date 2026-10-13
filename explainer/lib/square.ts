import narration from './narration.json';
import {
  C, alpha, circle, clamp, cool, during, easeIn, easeInOut, easeOut, glow, hatch, lerp, line, logoFamily, measure, mix, noise, rect, seg, text, wrap, type Ctx,
  type TextStyle,
} from './kit';

// The square cut for social video (1080 × 1080, 31 s). It has to read on a phone with the sound
// off, so it shows shapes rather than text: tool calls are a verb and a bar, processes are lanes,
// events are blips, and System 1's verdicts are one word. The bottom quarter belongs to the
// subtitles, clear of a player's controls.
//
// The agent starts full-screen; its tool calls push it aside as the machine comes alive, and
// blips fire everywhere. Polling that chaos costs it step after step. Then the chaos takes the
// frame, the System 1 ring forms in its middle and pulls it into ordered streams, and the two run
// side by side while the ring steers the agent's attention.

export const SIZE = 1080;
/** The opening title holds this long before the story starts; the story keeps its own clock. */
export const OPEN = 3.2;
export const DURATION = narration.duration;
/** Everything but the subtitles stays above this line. */
const STAGE = 800;

export const chapters = [
  { at: 0, title: 'Title' },
  { at: OPEN, title: 'The agent' },
  { at: OPEN + 5, title: 'A live machine' },
  { at: OPEN + 9.6, title: 'Polling' },
  { at: OPEN + 13.6, title: 'Order' },
  { at: OPEN + 18.4, title: 'Attention' },
  { at: OPEN + 26.6, title: 'Close' },
] as const;

// Captions are the narration (lib/narration.json), shown until the next line starts. The first and
// last lines are spoken over title cards, which already show them.
const lines = narration.lines as Array<{ at: number; text: string; caption?: boolean }>;
export const captions = lines.flatMap((line, index) => line.caption === false ? [] : [{
  from: line.at, to: (lines[index + 1]?.at ?? DURATION) - 0.2, text: line.text,
}]);

export const captionAt = (t: number) => captions.find(caption => t >= caption.from && t < caption.to)?.text ?? '';
export function chapterAt(t: number) {
  let current: (typeof chapters)[number] = chapters[0];
  for (const chapter of chapters) if (t >= chapter.at) current = chapter;
  return current;
}

// This cut is watched small, on phones: its blue and yellow are brighter and more saturated than
// the page's palette, ripe and electric. Red, orange and the neutrals stay Wave Kit's.
const P = { sky: '#2fd6ff', vivid: '#1f8fff', blue300: '#5ee0ff', amber: '#ffc81a' } as const;

/** Process activity, from quiet to busy, on a saturated blue ramp. */
function laneColor(level: number) {
  const x = clamp(level);
  return x < 0.5 ? mix('#13427c', P.vivid, x * 2) : mix(P.vivid, P.sky, (x - 0.5) * 2);
}

const polar = (x: number, y: number, r: number, a: number): [number, number] => [x + r * Math.cos(a), y + r * Math.sin(a)];
const rad = (deg: number) => (deg * Math.PI) / 180;

/** The largest size, up to style.size, at which the text fits the width. */
function fit(ctx: Ctx, value: string, style: TextStyle, width: number) {
  let size = style.size ?? 20;
  while (size > 10 && measure(ctx, value, { ...style, size }) > width) size -= 1;
  return size;
}

// ── The agent's panel: full-screen, to the side, off-screen, and back ─────────────────────────

type Box = { x: number; y: number; w: number; h: number; font: number };
const FULL: Box = { x: 60, y: 48, w: 960, h: 730, font: 36 };
const SIDE: Box = { x: 30, y: 84, w: 500, h: 694, font: 29 };
const mixBox = (a: Box, b: Box, k: number): Box => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k), font: lerp(a.font, b.font, k) });

function panelBox(t: number): Box {
  const box = mixBox(FULL, SIDE, easeInOut(seg(t, 5.5, 6.4)));
  const away = easeInOut(seg(t, 13.4, 14.1)) * (1 - easeInOut(seg(t, 18.3, 19.2)));
  return { ...box, x: lerp(box.x, -box.w - 60, away) };
}

const CUT = 21.3;
/** A tool call is a verb and a bar standing in for its arguments; `check` calls are polling. */
type Entry =
  | { at: number; kind: 'prompt'; text: string }
  | { at: number; kind: 'tool'; verb: 'read' | 'write' | 'run' | 'check'; bar: number; lane?: number }
  | { at: number; kind: 'result' }
  | { at: number; kind: 'wait' }
  | { at: number; kind: 'inject'; text: string };
const ENTRIES: Entry[] = [
  { at: 0.4, kind: 'prompt', text: 'Build a notes API' },
  { at: 1.2, kind: 'tool', verb: 'read', bar: 6 },
  { at: 2.0, kind: 'tool', verb: 'write', bar: 9 },
  { at: 2.8, kind: 'tool', verb: 'run', bar: 4 },
  { at: 3.4, kind: 'result' },
  { at: 5.9, kind: 'tool', verb: 'run', bar: 6 },
  { at: 6.4, kind: 'result' },
  { at: 7.1, kind: 'tool', verb: 'run', bar: 8 },
  { at: 7.7, kind: 'result' },
  // Without System 1 the agent can only spot-check the chaos, one step at a time.
  { at: 9.8, kind: 'tool', verb: 'check', bar: 6, lane: 0 },
  { at: 10.5, kind: 'tool', verb: 'check', bar: 4, lane: 3 },
  { at: 11.2, kind: 'tool', verb: 'check', bar: 7, lane: 1 },
  { at: 11.9, kind: 'tool', verb: 'check', bar: 5, lane: 4 },
  { at: 12.6, kind: 'tool', verb: 'check', bar: 3, lane: 2 },
  { at: 13.2, kind: 'tool', verb: 'run', bar: 4 },
  { at: 13.6, kind: 'wait' },
  { at: CUT + 0.1, kind: 'inject', text: 'System 1 · interrupt' },
  { at: 22.1, kind: 'tool', verb: 'read', bar: 7 },
  { at: 22.8, kind: 'tool', verb: 'write', bar: 6 },
  { at: 23.5, kind: 'tool', verb: 'run', bar: 8 },
  { at: 24.2, kind: 'result' },
  { at: 24.4, kind: 'inject', text: 'System 1 · note' },
  { at: 25.0, kind: 'tool', verb: 'run', bar: 4 },
  { at: 25.6, kind: 'result' },
];
const isCheck = (entry: Entry) => entry.kind === 'tool' && entry.verb === 'check';

const metrics = (box: Box) => ({ line: box.font * 1.55, header: box.font * 2.5, pad: box.font * 1.5 });

/** Lines scrolled off the top, eased as each new line arrives. */
function scrolled(t: number, box: Box) {
  const { line: height, header, pad } = metrics(box);
  const visible = Math.floor((box.h - header - pad) / height);
  let shown = 0;
  for (const entry of ENTRIES) shown += easeOut(seg(t, entry.at, entry.at + 0.35));
  return Math.max(0, shown - visible);
}

function lineY(t: number, box: Box, index: number) {
  const { line: height, header, pad } = metrics(box);
  return box.y + header + pad + (index - scrolled(t, box)) * height;
}

/** Right-aligned text in the panel's header: what the agent is doing, or what just arrived. */
function headerNote(ctx: Ctx, box: Box, value: string, color: string, a: number, weight = 800) {
  if (a <= 0) return;
  const f = box.font;
  const style: TextStyle = { weight, mono: weight < 700 };
  const titleRight = box.x + f * 0.8 + measure(ctx, '>_ agent', { size: f * 0.9, mono: true, weight: 800 });
  const size = fit(ctx, value, { ...style, size: f * 0.72 }, box.x + box.w - f * 0.8 - titleRight - 24);
  text(ctx, value, box.x + box.w - f * 0.8, box.y + metrics(box).header / 2 + size * 0.36, { ...style, size, color, alpha: a, align: 'right' });
}

function agent(ctx: Ctx, t: number, a: number) {
  const box = panelBox(t);
  if (a <= 0 || box.x + box.w < 0) return;
  const { line: height, header } = metrics(box);
  const f = box.font;
  // The border flashes when System 1 speaks.
  const flash = Math.max(during(t, CUT, CUT + 1.0, 0.2), 0.7 * during(t, 24.3, 25.1, 0.2));
  const flashColor = t < 23 ? C.hot : C.orange;
  rect(ctx, box.x, box.y, box.w, box.h, { color: mix(C.faint, flashColor, flash), width: 1.5 + flash * 1.5, alpha: a, radius: 8 });
  // A terminal prompt for a title.
  const iy = box.y + header / 2;
  const prompt = measure(ctx, '>_ ', { size: f * 0.9, mono: true, weight: 800 });
  text(ctx, '>_', box.x + f * 0.8, iy + f * 0.32, { size: f * 0.9, mono: true, weight: 800, color: P.sky, alpha: a });
  text(ctx, 'agent', box.x + f * 0.8 + prompt, iy + f * 0.32, { size: f * 0.9, mono: true, weight: 800, color: C.paper, alpha: a });
  line(ctx, box.x, box.y + header, box.x + box.w, box.y + header, { color: C.faint, width: 1.25, alpha: a });

  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x + 2, box.y + header + 4, box.w - 4, box.h - header - 8);
  ctx.clip();
  const x0 = box.x + f * 0.9;
  const verbWidth = measure(ctx, 'write', { size: f, mono: true, weight: 700 }) + f * 0.5;
  ENTRIES.forEach((entry, index) => {
    if (t < entry.at) return;
    const y = lineY(t, box, index);
    // Lines fade out before they reach the header as the transcript scrolls.
    const la = a * seg(t, entry.at, entry.at + 0.25) * clamp((y - (box.y + header + height * 0.6)) / (height * 0.6));
    if (la <= 0) return;
    const x = x0 + f * 0.3 * (1 - easeOut(seg(t, entry.at, entry.at + 0.25)));
    if (entry.kind === 'prompt') {
      // A message from the user, as a chat bubble on the right.
      const style: TextStyle = { size: f * 0.92, weight: 600 };
      const width = measure(ctx, entry.text, style) + f * 1.2;
      const right = box.x + box.w - f * 0.8 + f * 0.3 * (1 - easeOut(seg(t, entry.at, entry.at + 0.25)));
      const top = y - f * 1.08;
      rect(ctx, right - width, top, width, f * 1.5, { fill: '#1f2a37', color: alpha(P.sky, 0.35), width: 1.2, alpha: la, radius: f * 0.6 });
      text(ctx, entry.text, right - width / 2, y - f * 0.05, { ...style, color: C.paper, alpha: la, align: 'center' });
    } else if (entry.kind === 'tool') {
      const check = entry.verb === 'check';
      const lit = check ? during(t, entry.at, entry.at + 0.95, 0.12) : 0;
      if (lit > 0) rect(ctx, box.x + 6, y - f * 1.02, box.w - 12, f * 1.38, { fill: alpha(P.amber, 0.16), alpha: la * lit, radius: 4 });
      const tint = check ? P.amber : P.sky;
      circle(ctx, x + f * 0.2, y - f * 0.33, f * 0.17, { fill: tint, alpha: la });
      text(ctx, entry.verb, x + f * 0.75, y, { size: f, mono: true, weight: 700, color: check ? P.amber : C.paper, alpha: la });
      rect(ctx, x + f * 0.75 + verbWidth, y - f * 0.52, entry.bar * f * 0.55, f * 0.4, { fill: check ? alpha(P.amber, 0.35) : C.guide, alpha: la, radius: f * 0.2 });
    } else if (entry.kind === 'result') {
      text(ctx, '⎿', x + f * 0.75, y, { size: f, mono: true, color: C.muted, alpha: la });
      text(ctx, '✓', x + f * 1.8, y, { size: f, weight: 800, color: P.blue300, alpha: la });
    } else if (entry.kind === 'wait') {
      text(ctx, '⎿', x + f * 0.75, y, { size: f, mono: true, color: C.muted, alpha: la });
      const left = x + f * 1.75;
      const width = Math.min(box.x + box.w - left - f * 5.2, (Math.min(t, CUT) - entry.at) * 30);
      rect(ctx, left, y - f * 0.72, width, f * 0.78, { color: C.muted, width: 1.4, alpha: la, radius: 3 });
      hatch(ctx, left, y - f * 0.72, width, f * 0.78, C.muted, la * 0.7, f * 0.34);
      if (t < CUT) text(ctx, 'waiting…', left + width + f * 0.4, y, { size: f * 0.78, mono: true, color: C.soft, alpha: la });
      else {
        line(ctx, left + width, y - f * 0.9, left + width, y + f * 0.2, { color: C.hot, width: 4, alpha: la });
        text(ctx, 'stopped', left + width + f * 0.4, y, { size: f * 0.78, mono: true, weight: 700, color: C.hot, alpha: la });
      }
    } else {
      rect(ctx, x0 - f * 0.2, y - f * 0.95, f * 0.16, f * 1.25, { fill: C.orange, alpha: la, radius: 1 });
      text(ctx, entry.text, x + f * 0.75, y, { size: f, mono: true, weight: 700, color: C.orange, alpha: la });
    }
  });
  ctx.restore();
}

// ── The machine, and Spidermonkey working on it ────────────────────────────────────────────────
// Processes are lanes in a box; events are sparkles. When Spidermonkey takes over the box it
// shows its work as a decision model does it: it links sparkles of one kind into a pattern, boxes
// the region, and categorizes it. Routine patterns flash gray and go; the ones that matter turn
// orange (a note) or red (an interrupt) and reach the agent.

type Rect = { x: number; y: number; w: number; h: number };
const SIDE_BOX: Rect = { x: 560, y: 84, w: 490, h: 694 };
const FULL_BOX: Rect = { x: 40, y: 64, w: 1000, h: 714 };

/** Beside the agent, the whole stage while Spidermonkey shows its work, then beside the agent again. */
function machineBox(t: number): Rect {
  const k = easeInOut(seg(t, 13.4, 14.1)) * (1 - easeInOut(seg(t, 18.3, 19.2)));
  return { x: lerp(SIDE_BOX.x, FULL_BOX.x, k), y: lerp(SIDE_BOX.y, FULL_BOX.y, k), w: lerp(SIDE_BOX.w, FULL_BOX.w, k), h: lerp(SIDE_BOX.h, FULL_BOX.h, k) };
}

/** The box's working area, below its header. */
function inner(t: number): Rect {
  const box = machineBox(t);
  return { x: box.x + 28, y: box.y + 112, w: box.w - 56, h: box.h - 140 };
}

/** Processes as unlabeled lanes. The agent's own (`from` its run call) start when it starts them. */
const LANES = [
  { at: 6.0, from: 5 },
  { at: 7.2, from: 7 },
  { at: 5.8 },
  { at: 6.3 },
  { at: 6.7 },
];
const CELL = 26;
const PITCH = 33;
const STEP = 0.25;
const laneY = (t: number, index: number) => {
  const area = inner(t);
  return area.y + 14 + index * ((area.h - 28 - CELL) / (LANES.length - 1));
};
const laneRect = (t: number, index: number): Rect => {
  const area = inner(t);
  return { x: area.x + 6, y: laneY(t, index) - 16, w: area.w - 6, h: CELL + 32 };
};

function laneLevel(index: number, k: number) {
  const n = noise(k, 60 + index);
  return [0.35 + 0.35 * n, 0.2 + 0.25 * n, 0.45 + 0.45 * n, 0.12 + 0.2 * n, 0.2 + 0.4 * noise(Math.floor(k / 5), 70)][index]!;
}

/** The agent's storage process (lane 1) crashes and is later restarted. */
function storageState(ts: number): 'up' | 'crash' | 'down' {
  if (ts >= 19.9 && ts < 20.4) return 'crash';
  if (ts >= 20.4 && ts < 23.2) return 'down';
  return 'up';
}

const TONE = { sky: P.sky, soft: C.soft, amber: P.amber, hot: C.hot } as const;
type Tone = keyof typeof TONE;
type Verdict = 'ignore' | 'note' | 'interrupt';
const verdictColor = (verdict: Verdict) => (verdict === 'interrupt' ? C.hot : verdict === 'note' ? C.orange : C.soft);

/** What Spidermonkey finds: a region of the box (fractions of its area, or a lane), a kind of sparkle, a verdict. */
const PATTERNS: Array<{ at: number; tone: Tone; verdict: Verdict; region?: [number, number, number, number]; lane?: number }> = [
  { at: 14.8, tone: 'sky', verdict: 'ignore', region: [0.05, 0.34, 0.06, 0.4] },
  { at: 15.4, tone: 'soft', verdict: 'ignore', region: [0.6, 0.94, 0.56, 0.92] },
  { at: 16.0, tone: 'amber', verdict: 'ignore', region: [0.38, 0.62, 0.14, 0.5] },
  { at: 16.6, tone: 'sky', verdict: 'ignore', region: [0.1, 0.42, 0.58, 0.94] },
  { at: 17.2, tone: 'soft', verdict: 'ignore', region: [0.66, 0.95, 0.06, 0.38] },
  { at: 20.2, tone: 'hot', verdict: 'interrupt', lane: 1 },
  { at: 23.3, tone: 'amber', verdict: 'note', lane: 1 },
  { at: 25.5, tone: 'soft', verdict: 'ignore', region: [0.3, 0.9, 0.08, 0.36] },
];
const lifeOf = (verdict: Verdict) => (verdict === 'ignore' ? 1.6 : 2.6);

function patternRect(t: number, pattern: (typeof PATTERNS)[number]): Rect {
  if (pattern.lane !== undefined) return laneRect(t, pattern.lane);
  const area = inner(t);
  const [u0, u1, v0, v1] = pattern.region!;
  return { x: area.x + u0 * area.w, y: area.y + v0 * area.h, w: (u1 - u0) * area.w, h: (v1 - v0) * area.h };
}

function patternPoints(t: number, pattern: (typeof PATTERNS)[number], index: number): Array<[number, number]> {
  const rect = patternRect(t, pattern);
  const points: Array<[number, number]> = [];
  for (let j = 0; j < 5; j++) {
    const u = pattern.lane !== undefined ? (j + 0.3 + 0.4 * noise(index * 7 + j, 31)) / 5 : 0.12 + 0.76 * noise(index * 7 + j, 31);
    const v = pattern.lane !== undefined ? 0.5 + (noise(index * 7 + j, 32) - 0.5) * 0.3 : 0.15 + 0.7 * noise(index * 7 + j, 32);
    points.push([rect.x + u * rect.w, rect.y + v * rect.h]);
  }
  return points.sort((a, b) => a[0] - b[0]);
}

function sparkle(ctx: Ctx, x: number, y: number, color: string, age: number, a: number, size = 6) {
  circle(ctx, x, y, size + 22 * easeOut(age), { color, width: 2, alpha: a * (1 - age) * 0.9 });
  circle(ctx, x, y, size, { fill: color, alpha: a });
}

function machine(ctx: Ctx, t: number, a: number) {
  if (a <= 0) return;
  const box = machineBox(t);
  const area = inner(t);
  const watching = seg(t, 13.9, 14.5);
  // The box, its header: processes, then Spidermonkey watching them.
  rect(ctx, box.x, box.y, box.w, box.h, { color: mix(C.faint, C.orange, 0.5 * watching), width: 1.5 + watching * 0.5, alpha: a, radius: 8 });
  line(ctx, box.x, box.y + 90, box.x + box.w, box.y + 90, { color: C.faint, width: 1.25, alpha: a });
  // 'processes' leaves before Spidermonkey arrives, so the two never overlap.
  text(ctx, 'processes', box.x + 30, box.y + 58, { size: 32, weight: 700, color: C.soft, alpha: a * (1 - seg(t, 13.45, 13.85)), tracking: -0.3 });
  if (watching > 0) {
    const head = (t * 0.9) % 1;
    for (let i = 0; i < 28; i++) {
      const angle = (i / 28) * Math.PI * 2 - Math.PI / 2;
      const bright = Math.exp(-((head - i / 28 + 1) % 1) * 7);
      const [x1, y1] = polar(box.x + 48, box.y + 46, 11, angle);
      const [x2, y2] = polar(box.x + 48, box.y + 46, 18, angle);
      line(ctx, x1, y1, x2, y2, { color: C.orange, width: 2, alpha: a * watching * (0.25 + 0.75 * bright) });
    }
    text(ctx, 'Spidermonkey', box.x + 80, box.y + 58, { size: 32, weight: 800, color: C.orange, alpha: a * watching, tracking: -0.5 });
  }

  // Lanes: they recede a little under the polling, and further while Spidermonkey works.
  const columns = Math.floor((area.w - 40) / PITCH);
  const now = Math.floor(t / STEP);
  const frac = t / STEP - now;
  const agentBox = panelBox(t);
  const dim = (1 - 0.3 * seg(t, 9.4, 10.2)) * (1 - 0.3 * watching);
  LANES.forEach((lane, index) => {
    const la = a * seg(t, lane.at, lane.at + 0.4);
    if (la <= 0) return;
    const y = laneY(t, index);
    const own = lane.from !== undefined;
    if (own) {
      // The run call that started it, and a marker that it is the agent's.
      circle(ctx, area.x + 12, y + CELL / 2, 7, { fill: P.sky, alpha: la });
      const link = during(t, lane.at, lane.at + 1.3, 0.2);
      const fromY = lineY(t, agentBox, lane.from!) - agentBox.font * 0.33;
      const reach = easeOut(seg(t, lane.at, lane.at + 0.35));
      line(ctx, agentBox.x + agentBox.w, fromY, lerp(agentBox.x + agentBox.w, area.x, reach), lerp(fromY, y + CELL / 2, reach), { color: P.sky, width: 2.5, alpha: la * link * 0.85, dash: [6, 6] });
    }
    // A check from the agent lights the lane it inspects, joined to its check row.
    let lit = 0;
    ENTRIES.forEach((entry, row) => {
      if (entry.kind !== 'tool' || entry.lane !== index) return;
      const k = during(t, entry.at, entry.at + 0.95, 0.12);
      if (k <= 0) return;
      lit = Math.max(lit, k);
      line(ctx, agentBox.x + agentBox.w - 6, lineY(t, agentBox, row) - agentBox.font * 0.33, box.x + 8, y + CELL / 2, { color: P.amber, width: 3, alpha: k * 0.9 });
    });
    if (lit > 0) {
      const lr = laneRect(t, index);
      rect(ctx, box.x + 8, lr.y, box.w - 16, lr.h, { fill: alpha(P.amber, 0.14), color: alpha(P.amber, 0.9), width: 2, alpha: lit, radius: 6 });
    }
    for (let back = 0; back <= columns; back++) {
      const k = now - back;
      if (own && k * STEP < lane.at) continue;
      const x = area.x + 34 + (columns - 1 - back) * PITCH - frac * PITCH;
      const edge = clamp((x - (area.x + 34 - PITCH)) / PITCH) * (back === 0 ? clamp(frac * 4) : 1);
      const state = index === 1 ? storageState(k * STEP) : 'up';
      if (state === 'down') {
        rect(ctx, x + 1, y + 1, CELL - 2, CELL - 2, { color: C.faint, width: 1.2, alpha: la * edge, radius: 4 });
        continue;
      }
      const base = state === 'crash' ? C.hot : laneColor(laneLevel(index, k));
      rect(ctx, x, y, CELL, CELL, { fill: mix(base, P.amber, 0.7 * lit), alpha: la * edge * (state === 'crash' ? 1 : dim), radius: 4 });
    }
  });

  // Sparkles: events firing everywhere, a trickle at first and then all the time.
  const spacing = 0.1;
  const first = Math.max(0, Math.floor((t - 2.0 - 5.8) / spacing));
  const last = Math.floor((Math.min(t, 26.4) - 5.8) / spacing);
  for (let i = first; i <= last; i++) {
    const spawn = 5.8 + i * spacing;
    const keep = spawn < 9.6 ? lerp(0.12, 0.55, seg(spawn, 5.8, 9.6)) : spawn < 13.9 ? 0.55 : spawn < 18.3 ? 0.4 : 0.3;
    if (noise(i, 14) > keep) continue;
    const life = 1.0 + 0.7 * noise(i, 15);
    if (t > spawn + life) continue;
    const kind = noise(i, 17);
    const color = kind > 0.95 ? C.hot : kind > 0.83 ? P.amber : kind > 0.5 ? P.sky : kind > 0.22 ? P.vivid : C.soft;
    const x = area.x + 20 + noise(i, 11) * (area.w - 40);
    const y = area.y + 10 + noise(i, 12) * (area.h - 20);
    const fade = seg(t, spawn, spawn + 0.12) * (1 - seg(t, spawn + life - 0.3, spawn + life));
    sparkle(ctx, x, y, color, seg(t, spawn, spawn + life), a * fade);
  }

  // Patterns: link, box, categorize.
  PATTERNS.forEach((pattern, index) => {
    const life = lifeOf(pattern.verdict);
    if (t < pattern.at - 1.0 || t > pattern.at + life) return;
    const tone = TONE[pattern.tone];
    const verdict = verdictColor(pattern.verdict);
    const fade = a * (1 - seg(t, pattern.at + life - 0.4, pattern.at + life));
    const points = patternPoints(t, pattern, index);
    points.forEach(([x, y], j) => {
      const shown = seg(t, pattern.at - 0.9 + j * 0.14, pattern.at - 0.75 + j * 0.14);
      if (shown > 0) sparkle(ctx, x, y, tone, seg(t, pattern.at - 0.9 + j * 0.14, pattern.at + 0.6), fade * shown, 7);
    });
    // The links, drawn as the decision model connects them.
    const link = seg(t, pattern.at - 0.1, pattern.at + 0.4) * (points.length - 1);
    for (let j = 0; j < points.length - 1 && j < link; j++) {
      const [x1, y1] = points[j]!;
      const [x2, y2] = points[j + 1]!;
      const k = clamp(link - j);
      line(ctx, x1, y1, lerp(x1, x2, k), lerp(y1, y2, k), { color: tone, width: 2.5, alpha: fade * 0.9 });
    }
    // The region, then the verdict: routine flashes gray and goes; what matters holds its color.
    const grow = easeOut(seg(t, pattern.at + 0.3, pattern.at + 0.6));
    if (grow > 0) {
      const r = patternRect(t, pattern);
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const w = r.w * lerp(0.6, 1, grow);
      const h = r.h * lerp(0.6, 1, grow);
      const flash = pattern.verdict === 'ignore' ? during(t, pattern.at + 0.55, pattern.at + 1.1, 0.15) : 1;
      rect(ctx, cx - w / 2, cy - h / 2, w, h, { fill: alpha(verdict, 0.08 + 0.14 * flash), color: verdict, width: 2.5, alpha: fade * grow, radius: 8 });
      const labelY = Math.max(cy - h / 2 - 12, area.y + 26);
      text(ctx, pattern.verdict, cx - w / 2 + 6, labelY, { size: 30, weight: 800, color: verdict, alpha: fade * seg(t, pattern.at + 0.55, pattern.at + 0.75), tracking: -0.4 });
    }
  });
}

// ── Pings: Spidermonkey speaking to the agent ───────────────────────────────────────────────────

function ping(ctx: Ctx, t: number, o: { at: number; arrive: number; line: number; color: string; pattern: number }) {
  const p = seg(t, o.at, o.arrive);
  const fade = 1 - seg(t, o.arrive, o.arrive + 0.3);
  if (p <= 0 || fade <= 0) return;
  const r = patternRect(t, PATTERNS[o.pattern]!);
  const box = panelBox(t);
  const from: [number, number] = [machineBox(t).x, r.y + r.h / 2];
  const to: [number, number] = [box.x + box.w - 10, lineY(t, box, o.line) - box.font * 0.3];
  const q = easeInOut(p);
  const x = lerp(from[0], to[0], q);
  const y = lerp(from[1], to[1], q);
  line(ctx, from[0], from[1], x, y, { color: o.color, width: 4, alpha: fade * 0.85, dash: [8, 7] });
  glow(ctx, x, y, 44, o.color, fade);
  circle(ctx, x, y, 9, { fill: o.color, alpha: fade });
}

/** What just arrived, in the agent's header. */
function badge(ctx: Ctx, t: number, o: { at: number; label: string; color: string }) {
  headerNote(ctx, panelBox(t), o.label, o.color, during(t, o.at, o.at + 2.2, 0.2));
}

// ── The end card: a Tron-style title ─────────────────────────────────────────────────────────
// Two light-cycle trails, the executive's cyan and System 1's orange, race along the horizon of a
// glowing grid and collide; the collision ignites the wordmark in neon.

const HORIZON = 652;
const LOGO_Y = 522;
const IGNITE = 27.45;
let sheen: HTMLCanvasElement | undefined;

/** Run `draw` with an additive glow. Canvas blur is in device pixels, so it follows the frame's scale. */
function glowing(ctx: Ctx, color: string, blur: number, draw: () => void) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.shadowColor = color;
  ctx.shadowBlur = blur * ctx.getTransform().a;
  draw();
  ctx.restore();
}

function floor(ctx: Ctx, t: number, a: number) {
  if (a <= 0) return;
  const depth = SIZE - HORIZON;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, HORIZON, SIZE, depth);
  ctx.clip();
  glowing(ctx, P.vivid, 10, () => {
    ctx.strokeStyle = P.blue300;
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = a * 0.75;
    // Rails converge on the vanishing point.
    for (let i = -9; i <= 9; i++) {
      ctx.beginPath();
      ctx.moveTo(540, HORIZON);
      ctx.lineTo(540 + i * 330, SIZE);
      ctx.stroke();
    }
    // Cross lines scroll toward the viewer.
    const phase = (t * 0.9) % 1;
    for (let k = 0; k < 24; k++) {
      const z = (k + 1 - phase) * 0.42;
      const y = HORIZON + depth / z;
      if (y > SIZE + 2 || z <= 0) continue;
      ctx.globalAlpha = a * 0.75 * clamp(1.4 / z, 0, 1);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(SIZE, y);
      ctx.stroke();
    }
  });
  // Distance fades into the dark at the horizon.
  const fog = ctx.createLinearGradient(0, HORIZON, 0, HORIZON + 170);
  fog.addColorStop(0, 'rgba(0,0,0,0.95)');
  fog.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = fog;
  ctx.fillRect(0, HORIZON, SIZE, 170);
  ctx.restore();
}

/** A light-cycle trail along the horizon, from one edge toward the center. */
function trail(ctx: Ctx, t: number, side: -1 | 1, color: string) {
  const p = easeInOut(seg(t, 26.95, IGNITE));
  if (p <= 0) return;
  const edge = side < 0 ? -40 : SIZE + 40;
  const head = lerp(edge, 540, p);
  // Before the collision a comet; after it, the trail stays as the lit horizon.
  const tail = t < IGNITE ? lerp(edge, head, 0.35) : edge;
  const gradient = ctx.createLinearGradient(tail, 0, head, 0);
  gradient.addColorStop(0, alpha(color, 0));
  gradient.addColorStop(0.7, alpha(color, 0.8));
  gradient.addColorStop(1, alpha(C.pale, 1));
  glowing(ctx, color, 22, () => {
    ctx.strokeStyle = t < IGNITE ? gradient : color;
    ctx.globalAlpha = t < IGNITE ? 1 : 0.85;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(tail, HORIZON);
    ctx.lineTo(head, HORIZON);
    ctx.stroke();
    if (t < IGNITE) {
      ctx.fillStyle = C.pale;
      ctx.beginPath();
      ctx.arc(head, HORIZON, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

function wordmark(ctx: Ctx, size: number, paint: string | CanvasGradient, stroke = 0) {
  ctx.font = `700 ${size}px ${logoFamily()}`;
  ctx.textAlign = 'center';
  if ('letterSpacing' in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = '6px';
  if (stroke) {
    ctx.strokeStyle = paint;
    ctx.lineWidth = stroke;
    ctx.lineJoin = 'round';
    ctx.strokeText('SPIDERMONKEY', 543, 0);
  } else {
    ctx.fillStyle = paint;
    ctx.fillText('SPIDERMONKEY', 543, 0);
  }
}

function logo(ctx: Ctx, t: number) {
  const size = Math.min(92, 92 * (920 / measure(ctx, 'SPIDERMONKEY', { weight: 700, family: logoFamily(), tracking: 6, size: 92 })));
  const width = measure(ctx, 'SPIDERMONKEY', { weight: 700, family: logoFamily(), tracking: 6, size });
  // A neon tube flickers on, then holds.
  const flicker = t < IGNITE ? 0 : t < IGNITE + 0.45 ? (noise(Math.floor(t * 28), 5) > 0.3 ? 1 : 0) : 1;
  if (flicker <= 0) return;
  const punch = 1 + 0.07 * (1 - easeOut(seg(t, IGNITE, IGNITE + 0.6)));
  const heat = ctx.createLinearGradient(540 - width / 2, 0, 540 + width / 2, 0);
  heat.addColorStop(0, C.hot);
  heat.addColorStop(0.45, C.orange);
  heat.addColorStop(1, P.amber);
  const core = ctx.createLinearGradient(540 - width / 2, 0, 540 + width / 2, 0);
  core.addColorStop(0, '#ffd2b8');
  core.addColorStop(0.5, C.pale);
  core.addColorStop(1, '#fff7d6');
  ctx.save();
  ctx.translate(540, LOGO_Y);
  ctx.scale(punch, punch);
  ctx.translate(-540, 0);
  ctx.globalAlpha = flicker;
  // Outer glow, inner glow, the colored letters, then the tube's bright edge.
  glowing(ctx, C.orange, 70, () => { ctx.globalAlpha = flicker * 0.55; wordmark(ctx, size, heat); });
  glowing(ctx, C.hot, 24, () => { ctx.globalAlpha = flicker * 0.6; wordmark(ctx, size, heat); });
  wordmark(ctx, size, heat);
  glowing(ctx, P.amber, 6, () => { ctx.globalAlpha = flicker * 0.85; wordmark(ctx, size, core, 1.6); });
  ctx.restore();
  // A light sweep across the letters.
  const sweep = seg(t, 28.15, 28.85);
  if (sweep > 0 && sweep < 1 && typeof document !== 'undefined') {
    const scale = ctx.getTransform().a;
    const top = LOGO_Y - 110;
    sheen ??= document.createElement('canvas');
    sheen.width = Math.ceil(SIZE * scale);
    sheen.height = Math.ceil(160 * scale);
    const o = sheen.getContext('2d')!;
    o.setTransform(scale, 0, 0, scale, 0, -top * scale);
    o.save();
    o.translate(0, LOGO_Y);
    wordmark(o, size, '#ffffff');
    o.restore();
    o.globalCompositeOperation = 'source-in';
    const x = lerp(540 - width / 2 - 160, 540 + width / 2 + 160, easeInOut(sweep));
    const band = o.createLinearGradient(x - 90, 0, x + 90, 0);
    band.addColorStop(0, 'rgba(255,255,255,0)');
    band.addColorStop(0.5, 'rgba(255,255,255,0.95)');
    band.addColorStop(1, 'rgba(255,255,255,0)');
    o.fillStyle = band;
    o.fillRect(0, top, SIZE, 160);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(sheen, 0, top, SIZE, 160);
    ctx.restore();
  }
}

function endCard(ctx: Ctx, t: number) {
  if (t < 26.9) return;
  // A faint haze rising off the horizon.
  const haze = ctx.createLinearGradient(0, HORIZON, 0, HORIZON - 240);
  haze.addColorStop(0, alpha(P.vivid, 0.16 * seg(t, IGNITE, IGNITE + 0.8)));
  haze.addColorStop(1, alpha(P.vivid, 0));
  ctx.fillStyle = haze;
  ctx.fillRect(0, HORIZON - 240, SIZE, 240);
  floor(ctx, t, seg(t, 27.0, 27.7));
  trail(ctx, t, -1, P.sky);
  trail(ctx, t, 1, C.orange);
  // The collision: a flash at the meeting point.
  const flash = seg(t, IGNITE, IGNITE + 0.5);
  if (flash > 0 && flash < 1) {
    glow(ctx, 540, HORIZON, 120 * easeOut(flash) + 30, C.pale, (1 - flash) * 1.2);
    // A shockwave runs out along the horizon.
    glowing(ctx, P.sky, 18, () => {
      ctx.globalAlpha = 1 - flash;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(540, HORIZON, 30 + 620 * easeOut(flash), 6 + 46 * easeOut(flash), 0, 0, Math.PI * 2);
      ctx.stroke();
    });
  }
  logo(ctx, t);
  const b = seg(t, 27.9, 28.4);
  ctx.save();
  ctx.shadowColor = alpha(P.sky, 0.8);
  ctx.shadowBlur = 14 * ctx.getTransform().a;
  text(ctx, 'always-on System 1 for coding agents', 540, 592, { size: 34, weight: 500, color: '#ffffff', alpha: b, align: 'center', tracking: 0.5 });
  ctx.restore();
}

function caption(ctx: Ctx, t: number) {
  // The bottom quarter is the subtitles' own: large, at most two lines, centered, and clear of
  // the play bar a player draws over the bottom of the frame.
  for (const entry of captions) {
    const a = during(t, entry.from, entry.to, 0.3);
    if (a <= 0) continue;
    let size = 54;
    let rows = wrap(ctx, entry.text, 990, { size, weight: 700 });
    while (rows.length > 2 && size > 40) {
      size -= 2;
      rows = wrap(ctx, entry.text, 990, { size, weight: 700 });
    }
    const height = size * 1.2;
    const first = 896 - ((rows.length - 1) * height) / 2;
    rows.forEach((value, index) => {
      text(ctx, value, 540, first + index * height, { size, weight: 700, color: C.paper, alpha: a, align: 'center', tracking: -0.5 });
    });
  }
}

// ── The opening: the point, before anything else ───────────────────────────────────────────────
// Whoever scrolls past after a second should still get it: a System 1 for coding agents. The
// headline carries the idea; the wordmark is small. The first frame is also the poster image.

function opening(ctx: Ctx, t: number) {
  const a = 1 - seg(t, OPEN - 0.45, OPEN - 0.05);
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  floor(ctx, t, 0.55);
  glowing(ctx, P.sky, 16, () => { ctx.strokeStyle = P.sky; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, HORIZON); ctx.lineTo(540, HORIZON); ctx.stroke(); });
  glowing(ctx, C.orange, 16, () => { ctx.strokeStyle = C.orange; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(540, HORIZON); ctx.lineTo(SIZE, HORIZON); ctx.stroke(); });
  // The wordmark, small.
  const size = 40;
  const width = measure(ctx, 'SPIDERMONKEY', { weight: 700, family: logoFamily(), tracking: 6, size });
  const heat = ctx.createLinearGradient(540 - width / 2, 0, 540 + width / 2, 0);
  heat.addColorStop(0, C.hot);
  heat.addColorStop(0.45, C.orange);
  heat.addColorStop(1, P.amber);
  ctx.save();
  ctx.translate(0, 300);
  glowing(ctx, C.orange, 24, () => { ctx.globalAlpha = a * 0.6; wordmark(ctx, size, heat); });
  wordmark(ctx, size, heat);
  ctx.restore();
  // The headline: what it is.
  const style: TextStyle = { size: 100, weight: 800, tracking: -2.5 };
  const lead = measure(ctx, 'A ', style);
  const name = measure(ctx, 'System 1', style);
  const left = 540 - (lead + name) / 2;
  text(ctx, 'A ', left, 452, { ...style, color: C.paper });
  glowing(ctx, C.orange, 26, () => { ctx.globalAlpha = a * 0.7; text(ctx, 'System 1', left + lead, 452, { ...style, color: C.orange }); });
  text(ctx, 'System 1', left + lead, 452, { ...style, color: C.orange });
  text(ctx, 'for coding agents', 540, 566, { ...style, color: C.paper, align: 'center' });
  ctx.restore();
}

// ── The frame ───────────────────────────────────────────────────────────────────────────────────

/** Everything but the subtitles, on the story's own clock. */
function story(ctx: Ctx, t: number) {
  const out = 1 - seg(t, 26.6, 26.9);
  machine(ctx, t, seg(t, 5.6, 6.2) * out);
  agent(ctx, t, seg(t, 0, 0.4) * out);
  const interrupt = PATTERNS.findIndex(pattern => pattern.verdict === 'interrupt');
  const note = PATTERNS.findIndex(pattern => pattern.verdict === 'note');
  ping(ctx, t, { at: 20.8, arrive: CUT, line: ENTRIES.findIndex(entry => entry.kind === 'wait'), color: C.hot, pattern: interrupt });
  ping(ctx, t, { at: 23.7, arrive: 24.35, line: ENTRIES.findIndex(entry => entry.kind === 'inject' && entry.text.endsWith('note')), color: C.orange, pattern: note });
  badge(ctx, t, { at: CUT, label: 'interrupt ← System 1', color: C.hot });
  badge(ctx, t, { at: 24.35, label: 'note ← System 1', color: C.orange });
  endCard(ctx, t);
}

export function render(ctx: Ctx, t: number) {
  ctx.save();
  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, SIZE, SIZE);
  if (t > OPEN - 0.5) story(ctx, t - OPEN);
  opening(ctx, t);
  caption(ctx, t);
  ctx.restore();
}
