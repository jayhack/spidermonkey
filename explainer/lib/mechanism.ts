import { C, alpha, circle, during, easeInOut, lerp, line, logoFamily, measure, mix, noise, rect, seg, text, type Ctx } from './kit';

// How Spidermonkey works, as a short square loop (1080 × 1080, 14 s, no narration) to sit beside
// a post: input streams from the machine are sampled every tick, one Jev call classifies what
// each stream did, and what matters is escalated to the agent. The agent can also register a
// stream of its own, with guidance, and it is classified like the rest.

export const SIZE = 1080;
export const DURATION = 14;
export const chapters = [
  { at: 0, title: 'Streams' },
  { at: 4.6, title: 'A spike' },
  { at: 6.4, title: 'A registered stream' },
  { at: 8.8, title: 'A process dies' },
] as const;
export const captionAt = () => '';
export function chapterAt(t: number) {
  let current: (typeof chapters)[number] = chapters[0];
  for (const chapter of chapters) if (t >= chapter.at) current = chapter;
  return current;
}

// The square cut's brighter blue and yellow, for small screens.
const P = { sky: '#2fd6ff', vivid: '#1f8fff', amber: '#ffc81a' } as const;

// ── Layout ──────────────────────────────────────────────────────────────────────────────────────

const LANE = { x0: 60, x1: 560, top: 300, gap: 104, band: 50, pxPerSecond: 62 };
const NOW = LANE.x1 + 18;
const JEV = { x: 640, y: 462, w: 130, h: 136 };
const OUT = { x: 812, x1: 1036 };
const AGENT = { x: 812, y: 112, w: 224, h: 72 };
const TICKS = Array.from({ length: 13 }, (_, i) => 1.2 + i);

type Verdict = 'ignore' | 'note' | 'interrupt';
const STREAMS = [
  { label: 'memory' },
  { label: 'processes' },
  { label: 'ports' },
  { label: 'logs' },
  { label: 'tests' },
  { label: 'npm test', registered: 7.1 },
] as const;
const laneY = (index: number) => LANE.top + index * LANE.gap;
const verdictColor = (verdict: Verdict) => (verdict === 'interrupt' ? C.hot : verdict === 'note' ? P.amber : C.soft);

/** What one Jev call concluded about a stream at a tick. */
function classify(index: number, at: number): { label: string; p: number; verdict: Verdict } {
  if (index === 0 && at >= 5.0 && at < 7.6) return { label: 'spiking', p: 0.91, verdict: 'note' };
  if (index === 1 && at >= 9.0 && at < 12.6) return { label: 'exited', p: 0.96, verdict: 'interrupt' };
  if (index === 5) return { label: 'passing', p: 0.06, verdict: 'ignore' };
  return { label: 'routine', p: [0.04, 0.02, 0.03, 0.07, 0.05][index]!, verdict: 'ignore' };
}

/** The ticks at which a stream first becomes worth escalating. */
const ESCALATIONS = [
  { index: 0, at: 5.2, verdict: 'note' as Verdict },
  { index: 1, at: 9.2, verdict: 'interrupt' as Verdict },
];

/** A stream exists from the start, or from when the agent registers it. */
const present = (index: number, t: number) => {
  const stream = STREAMS[index]!;
  return 'registered' in stream ? seg(t, stream.registered, stream.registered + 0.5) : seg(t, 0.2 + index * 0.1, 0.7 + index * 0.1);
};

// ── Signals: each stream as it looks over time ─────────────────────────────────────────────────

const memory = (ts: number) => 0.3 + 0.08 * noise(Math.floor(ts * 4), 1) + 0.55 * easeInOut(seg(ts, 4.4, 5.2)) * (1 - easeInOut(seg(ts, 7.2, 8.2)));

function signal(ctx: Ctx, index: number, t: number, a: number) {
  const y = laneY(index);
  const age = (x: number) => t - (NOW - x) / LANE.pxPerSecond;
  ctx.save();
  ctx.beginPath();
  ctx.rect(LANE.x0, y - 4, LANE.x1 - LANE.x0, LANE.band + 8);
  ctx.clip();
  if (index === 0) {
    // Memory: a line chart that spikes.
    ctx.save();
    ctx.globalAlpha = a;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    let previous: [number, number] | undefined;
    for (let x = LANE.x0; x <= NOW; x += 6) {
      const ts = age(x);
      if (ts < 0) continue;
      const v = memory(ts);
      const point: [number, number] = [x, y + LANE.band - v * LANE.band];
      if (previous) {
        ctx.strokeStyle = v > 0.55 ? P.amber : P.sky;
        ctx.beginPath();
        ctx.moveTo(previous[0], previous[1]);
        ctx.lineTo(point[0], point[1]);
        ctx.stroke();
      }
      previous = point;
    }
    ctx.restore();
  } else if (index === 1) {
    // Processes: blocks for running processes; one dies.
    for (let k = Math.floor(age(LANE.x0) * 4); k <= Math.floor(t * 4); k++) {
      const ts = k / 4;
      if (ts < 0) continue;
      const x = NOW - (t - ts) * LANE.pxPerSecond;
      for (let row = 0; row < 3; row++) {
        const dead = row === 1 && ts >= 8.75 && ts < 12.4;
        if (dead) continue;
        rect(ctx, x, y + 4 + row * 15, 12, 11, { fill: mix(P.vivid, P.sky, noise(k * 3 + row, 2)), alpha: a * 0.9, radius: 2 });
      }
      if (Math.abs(ts - 8.75) < 0.01) {
        const cy = y + 4 + 15 + 5;
        line(ctx, x - 8, cy - 8, x + 8, cy + 8, { color: C.hot, width: 3.5, alpha: a });
        line(ctx, x - 8, cy + 8, x + 8, cy - 8, { color: C.hot, width: 3.5, alpha: a });
      }
    }
  } else if (index === 2) {
    // Ports: listeners as dots.
    for (let k = Math.floor(age(LANE.x0) * 2); k <= Math.floor(t * 2); k++) {
      if (k < 0 || noise(k, 3) < 0.45) continue;
      const x = NOW - (t - k / 2) * LANE.pxPerSecond;
      circle(ctx, x, y + 12 + noise(k, 4) * (LANE.band - 24), 5, { fill: P.sky, alpha: a * 0.85 });
    }
  } else if (index === 3) {
    // Logs: a tick for every line.
    for (let k = Math.floor(age(LANE.x0) * 8); k <= Math.floor(t * 8); k++) {
      if (k < 0 || noise(k, 5) < 0.35) continue;
      const x = NOW - (t - k / 8) * LANE.pxPerSecond;
      const h = 10 + noise(k, 6) * (LANE.band - 14);
      line(ctx, x, y + LANE.band, x, y + LANE.band - h, { color: C.soft, width: 2.5, alpha: a * 0.8 });
    }
  } else {
    // Test runs: a mark for each passing run.
    const every = index === 4 ? 1.6 : 1.1;
    for (let k = Math.floor(age(LANE.x0) / every); k <= Math.floor(t / every); k++) {
      const ts = k * every;
      if (ts < 0 || (index === 5 && ts < 7.3)) continue;
      const x = NOW - (t - ts) * LANE.pxPerSecond;
      text(ctx, '✓', x - 9, y + LANE.band - 12, { size: 30, weight: 800, color: P.sky, alpha: a });
    }
  }
  ctx.restore();
}

// ── The frame ───────────────────────────────────────────────────────────────────────────────────

export function render(ctx: Ctx, t: number) {
  ctx.save();
  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, SIZE, SIZE);
  // Fade in and out, so the clip loops.
  const fade = seg(t, 0, 0.5) * (1 - seg(t, DURATION - 0.6, DURATION));
  ctx.globalAlpha = fade;

  // The three steps, each lit while it happens.
  const tick = TICKS.reduce((last, at) => (t >= at ? at : last), -10);
  const sampling = during(t, tick, tick + 0.45, 0.1);
  const classifying = during(t, tick + 0.3, tick + 0.75, 0.1);
  const escalating = Math.max(...ESCALATIONS.map(e => during(t, e.at + 0.2, e.at + 1.3, 0.15)));
  const steps: Array<[string, number, string]> = [['sample', sampling, P.sky], ['classify', classifying, C.orange], ['escalate', escalating, C.hot]];
  const widths = steps.map(([word]) => measure(ctx, word, { size: 38, weight: 800 }));
  const arrow = measure(ctx, '  →  ', { size: 38, weight: 800 });
  let x = 540 - (widths.reduce((sum, w) => sum + w, 0) + arrow * 2) / 2;
  steps.forEach(([word, lit, color], i) => {
    text(ctx, word, x, 78, { size: 38, weight: 800, color: mix(C.muted, color, 0.35 + 0.65 * lit), tracking: -0.6 });
    x += widths[i]!;
    if (i < 2) { text(ctx, '  →  ', x, 78, { size: 38, weight: 800, color: C.guide }); x += arrow; }
  });

  // The agent, which receives escalations and can register a stream of its own.
  const hit = (verdict: Verdict) => Math.max(...ESCALATIONS.filter(e => e.verdict === verdict).map(e => during(t, e.at + 1.0, e.at + 2.0, 0.15)));
  const flash = Math.max(hit('note'), hit('interrupt'));
  const flashColor = hit('interrupt') > 0 ? C.hot : P.amber;
  rect(ctx, AGENT.x, AGENT.y, AGENT.w, AGENT.h, { color: mix(C.guide, flashColor, flash), width: 2 + flash, fill: alpha(flashColor, 0.1 * flash), radius: 10 });
  const prompt = measure(ctx, '>_ ', { size: 32, mono: true, weight: 800 });
  text(ctx, '>_', AGENT.x + 26, AGENT.y + 47, { size: 32, mono: true, weight: 800, color: P.sky });
  text(ctx, 'agent', AGENT.x + 26 + prompt, AGENT.y + 47, { size: 32, mono: true, weight: 800, color: C.paper });
  text(ctx, 'input streams', LANE.x0, LANE.top - 66, { size: 26, weight: 700, color: C.muted });
  text(ctx, 'classifications', OUT.x, LANE.top - 66, { size: 26, weight: 700, color: C.muted });

  // Streams, the moment of sampling, and the packets carried to Jev.
  STREAMS.forEach((stream, index) => {
    const a = present(index, t);
    if (a <= 0) return;
    const y = laneY(index);
    const registered = 'registered' in stream;
    text(ctx, stream.label, LANE.x0, y - 12, { size: 26, weight: 700, color: registered ? P.sky : C.soft, alpha: a });
    if (registered) {
      const w = measure(ctx, stream.label, { size: 26, weight: 700 });
      text(ctx, '· registered by the agent: "flag regressions"', LANE.x0 + w + 12, y - 12, { size: 20, color: P.sky, alpha: a * 0.85 });
    }
    line(ctx, LANE.x0, y + LANE.band + 6, LANE.x1, y + LANE.band + 6, { color: C.faint, width: 1.5, alpha: a });
    signal(ctx, index, t, a);
    for (const at of TICKS) {
      if (at < ('registered' in stream ? stream.registered + 0.5 : 0)) continue;
      const travel = seg(t, at, at + 0.35);
      if (travel <= 0 || travel >= 1) continue;
      const { verdict } = classify(index, at);
      const color = verdict === 'ignore' ? P.sky : verdictColor(verdict);
      const q = easeInOut(travel);
      const px = lerp(NOW, JEV.x, q);
      const py = lerp(y + LANE.band / 2, JEV.y + JEV.h / 2, q);
      circle(ctx, NOW, y + LANE.band / 2, 8 * (1 - travel), { fill: P.sky, alpha: a });
      circle(ctx, px, py, 6, { fill: color, alpha: a * 0.95 });
    }
  });
  line(ctx, NOW, LANE.top - 20, NOW, laneY(5) + LANE.band + 10, { color: alpha(P.sky, 0.25 + 0.6 * sampling), width: 2 });

  // The agent registers a stream: a request travels from it to a new lane.
  const ask = seg(t, 6.4, 7.1);
  if (ask > 0 && ask < 1) {
    const q = easeInOut(ask);
    const fx = AGENT.x;
    const fy = AGENT.y + AGENT.h;
    const tx = LANE.x0 + 120;
    const ty = laneY(5) - 20;
    const cx = lerp(fx, tx, q);
    const cy = lerp(fy, ty, q);
    line(ctx, fx, fy, cx, cy, { color: P.sky, width: 2.5, alpha: 0.85, dash: [7, 7] });
    const label = 'watch npm test';
    const w = measure(ctx, label, { size: 22, mono: true, weight: 700 }) + 22;
    rect(ctx, cx - w / 2, cy - 22, w, 36, { fill: '#06202a', color: P.sky, width: 1.5, radius: 6 });
    text(ctx, label, cx, cy + 3, { size: 22, mono: true, weight: 700, color: P.sky, align: 'center' });
  }

  // Jev: one decision-model call per tick, over every stream.
  const pulse = during(t, tick + 0.3, tick + 0.75, 0.1);
  const ring = seg(t, tick + 0.3, tick + 0.9);
  if (ring > 0 && ring < 1) rect(ctx, JEV.x - 18 * ring, JEV.y - 18 * ring, JEV.w + 36 * ring, JEV.h + 36 * ring, { color: C.orange, width: 2, alpha: 1 - ring, radius: 14 + 10 * ring });
  rect(ctx, JEV.x, JEV.y, JEV.w, JEV.h, { color: C.orange, width: 2.5 + pulse * 1.5, fill: C.ink, radius: 14 });
  text(ctx, 'Jev', JEV.x + JEV.w / 2, JEV.y + 70, { size: 44, weight: 800, color: C.orange, align: 'center', tracking: -1 });
  text(ctx, 'decision', JEV.x + JEV.w / 2, JEV.y + 98, { size: 18, weight: 600, color: C.soft, align: 'center' });
  text(ctx, 'model', JEV.x + JEV.w / 2, JEV.y + 118, { size: 18, weight: 600, color: C.soft, align: 'center' });

  // Classifications: one per stream, refreshed at each tick.
  STREAMS.forEach((stream, index) => {
    const a = present(index, t);
    if (a <= 0) return;
    const y = laneY(index);
    const shown = TICKS.reduce((last, at) => (t >= at + 0.5 && at >= ('registered' in stream ? stream.registered + 0.5 : 0) ? at : last), -1);
    if (shown < 0) return;
    const { label, p, verdict } = classify(index, shown);
    const fresh = during(t, shown + 0.5, shown + 0.75, 0.12);
    const color = verdictColor(verdict);
    // The output's link back to Jev.
    line(ctx, JEV.x + JEV.w, JEV.y + JEV.h / 2, OUT.x - 10, y + LANE.band / 2, { color: alpha(color, 0.25 + 0.5 * fresh), width: 1.5 });
    text(ctx, label, OUT.x, y + 16, { size: 26, weight: 800, color: verdict === 'ignore' ? C.paper : color, alpha: a, tracking: -0.3 });
    text(ctx, verdict, OUT.x1, y + 16, { size: 22, weight: 700, color, alpha: a, align: 'right' });
    rect(ctx, OUT.x, y + 30, OUT.x1 - OUT.x, 8, { fill: C.faint, alpha: a, radius: 4 });
    rect(ctx, OUT.x, y + 30, (OUT.x1 - OUT.x) * p, 8, { fill: verdict === 'ignore' ? C.muted : color, alpha: a, radius: 4 });
    text(ctx, `p ${p.toFixed(2)}`, OUT.x, y + 62, { size: 18, mono: true, color: C.muted, alpha: a });
    if (fresh > 0 && verdict !== 'ignore') rect(ctx, OUT.x - 14, y - 16, OUT.x1 - OUT.x + 28, 92, { color, width: 2, alpha: a * 0.8, radius: 8 });
  });

  // Escalations rise to the agent along the right margin; the agent's box names what arrived.
  for (const escalation of ESCALATIONS) {
    const color = verdictColor(escalation.verdict);
    const rise = seg(t, escalation.at + 0.4, escalation.at + 1.0);
    const y0 = laneY(escalation.index) + 16;
    const margin = OUT.x1 + 26;
    if (rise > 0 && rise < 1) {
      const q = easeInOut(rise);
      const y = lerp(y0, AGENT.y + AGENT.h / 2, q);
      line(ctx, OUT.x1 + 14, y0, margin, y0, { color, width: 3, alpha: 0.9 });
      line(ctx, margin, y0, margin, y, { color, width: 3, alpha: 0.9 });
      circle(ctx, margin, y, 8, { fill: color });
    }
    const arrived = during(t, escalation.at + 1.0, escalation.at + 2.2, 0.15);
    text(ctx, escalation.verdict, AGENT.x - 18, AGENT.y + 47, { size: 30, weight: 800, color, alpha: arrived, align: 'right', tracking: -0.4 });
  }

  // The wordmark, small.
  const size = 22;
  const width = measure(ctx, 'SPIDERMONKEY', { weight: 700, family: logoFamily(), tracking: 4, size });
  const heat = ctx.createLinearGradient(60, 0, 60 + width, 0);
  heat.addColorStop(0, C.hot);
  heat.addColorStop(0.45, C.orange);
  heat.addColorStop(1, P.amber);
  ctx.font = `700 ${size}px ${logoFamily()}`;
  if ('letterSpacing' in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = '4px';
  ctx.fillStyle = heat;
  ctx.textAlign = 'left';
  ctx.fillText('SPIDERMONKEY', 60, 1030);
  if ('letterSpacing' in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = '0px';
  text(ctx, 'github.com/jayhack/spidermonkey', 1020, 1030, { size: 20, mono: true, color: C.muted, align: 'right' });
  ctx.restore();
}

