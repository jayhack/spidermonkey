import { waveColors, wavePalette } from '@jayhack/wave-kit';

// Drawing primitives for the explainer. Every frame is a pure function of time, so the
// player can scrub anywhere and a recorder can step through frames deterministically.

export const W = 1600;
export const H = 900;

/** Wave Kit roles: paper labels, blue observations, orange System 1, red interventions, neutral guides. */
export const C = {
  ink: waveColors.ink,
  paper: waveColors.paper,
  guide: '#404040', // neutral-700: axes, guides, borders
  faint: '#262626', // neutral-800
  muted: '#737373', // neutral-500
  soft: '#a3a3a3', // neutral-400
  blue950: '#2a3550',
  blue800: '#34507a',
  blue: '#1e6aa0',
  vivid: waveColors.blue.vivid,
  blue300: '#4dabd9',
  sky: waveColors.blue.light,
  red: waveColors.red.base,
  redVivid: waveColors.red.vivid,
  hot: waveColors.red.hot,
  orange: waveColors.yellow.orange,
  orangeLight: '#fb923c',
  amber: waveColors.yellow.amber,
  yellow: waveColors.yellow.base,
  pale: waveColors.yellow.pale,
} as const;

export const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

export const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
/** Progress through [a, b], clamped to 0..1. */
export const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
export const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
export const easeIn = (x: number) => x * x * x;
/** Visible between a and b, fading in and out over `fade` seconds. */
export const during = (t: number, a: number, b: number, fade = 0.5) => Math.min(seg(t, a, a + fade), 1 - seg(t, b - fade, b));

/** Deterministic noise in [0, 1). */
export function noise(i: number, salt = 0) {
  let h = (i * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Channels of a #rrggbb color or of an rgb(r,g,b) string produced by mix. */
function rgb(color: string): [number, number, number] {
  if (color.startsWith('rgb')) {
    const [r = 0, g = 0, b = 0] = color.slice(color.indexOf('(') + 1, -1).split(',').map(Number);
    return [r, g, b];
  }
  const value = parseInt(color.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function mix(a: string, b: string, k: number) {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const q = clamp(k);
  return `rgb(${Math.round(lerp(r1, r2, q))},${Math.round(lerp(g1, g2, q))},${Math.round(lerp(b1, b2, q))})`;
}

export function alpha(hex: string, a: number) {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${clamp(a)})`;
}

/** Wave Kit's cool-to-warm energy ramp: 0 rests at deep navy, 1 peaks at cream. */
export function heat(x: number) {
  const scaled = clamp(x) * (wavePalette.length - 1);
  const index = Math.min(wavePalette.length - 2, Math.floor(scaled));
  return mix(wavePalette[index]!, wavePalette[index + 1]!, scaled - index);
}

/** The cool half of the ramp only: activity that is not alarming. */
export function cool(x: number) {
  const ramp = wavePalette.slice(0, 6);
  const scaled = clamp(x) * (ramp.length - 1);
  const index = Math.min(ramp.length - 2, Math.floor(scaled));
  return mix(ramp[index]!, ramp[index + 1]!, scaled - index);
}

export type Ctx = CanvasRenderingContext2D;

export interface TextStyle {
  size?: number;
  weight?: number;
  color?: string | CanvasGradient;
  /** A font family list in place of the system sans or mono, such as logoFamily(). */
  family?: string;
  alpha?: number;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  mono?: boolean;
  tracking?: number;
}

function font(style: TextStyle) {
  return `${style.weight ?? 500} ${style.size ?? 20}px ${style.family ?? (style.mono ? MONO : SANS)}`;
}

let logo: string | undefined;

/** The wordmark's font family (Syncopate, from next/font via --font-logo), or the system sans. */
export function logoFamily() {
  if (logo) return logo;
  if (typeof document === 'undefined') return SANS;
  const family = getComputedStyle(document.documentElement).getPropertyValue('--font-logo').trim();
  return family ? (logo = `${family}, ${SANS}`) : SANS;
}

/** Resolves once the wordmark's font can be drawn on a canvas. */
export async function logoReady() {
  if (typeof document === 'undefined') return;
  await document.fonts.load(`700 80px ${logoFamily()}`, 'SPIDERMONKEY').catch(() => []);
}

export function text(ctx: Ctx, value: string, x: number, y: number, style: TextStyle = {}) {
  if ((style.alpha ?? 1) <= 0.001) return;
  ctx.save();
  ctx.globalAlpha *= clamp(style.alpha ?? 1);
  ctx.font = font(style);
  ctx.fillStyle = style.color ?? C.paper;
  ctx.textAlign = style.align ?? 'left';
  ctx.textBaseline = style.baseline ?? 'alphabetic';
  if ('letterSpacing' in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = `${style.tracking ?? 0}px`;
  ctx.fillText(value, x, y);
  ctx.restore();
}

export function measure(ctx: Ctx, value: string, style: TextStyle = {}) {
  ctx.save();
  ctx.font = font(style);
  if ('letterSpacing' in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = `${style.tracking ?? 0}px`;
  const width = ctx.measureText(value).width;
  ctx.restore();
  return width;
}

/** Greedy word wrap to a pixel width. */
export function wrap(ctx: Ctx, value: string, width: number, style: TextStyle = {}) {
  const lines: string[] = [];
  let line = '';
  for (const word of value.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(ctx, next, style) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export interface StrokeStyle {
  color?: string;
  width?: number;
  alpha?: number;
  dash?: number[];
  fill?: string;
}

export function circle(ctx: Ctx, x: number, y: number, r: number, style: StrokeStyle = {}, from = 0, sweep = 1) {
  if ((style.alpha ?? 1) <= 0.001 || r <= 0 || sweep <= 0) return;
  ctx.save();
  ctx.globalAlpha *= clamp(style.alpha ?? 1);
  ctx.beginPath();
  const start = -Math.PI / 2 + from * Math.PI * 2;
  ctx.arc(x, y, r, start, start + sweep * Math.PI * 2);
  if (style.fill) {
    ctx.fillStyle = style.fill;
    ctx.fill();
  }
  if (style.color) {
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width ?? 1.5;
    ctx.setLineDash(style.dash ?? []);
    ctx.stroke();
  }
  ctx.restore();
}

export function line(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, style: StrokeStyle = {}) {
  if ((style.alpha ?? 1) <= 0.001) return;
  ctx.save();
  ctx.globalAlpha *= clamp(style.alpha ?? 1);
  ctx.strokeStyle = style.color ?? C.guide;
  ctx.lineWidth = style.width ?? 1.5;
  ctx.lineCap = 'round';
  ctx.setLineDash(style.dash ?? []);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

/** A partially drawn line, from its start to fraction k. */
export function drawLine(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, k: number, style: StrokeStyle = {}) {
  if (k <= 0) return;
  line(ctx, x1, y1, lerp(x1, x2, clamp(k)), lerp(y1, y2, clamp(k)), style);
}

export function rect(ctx: Ctx, x: number, y: number, w: number, h: number, style: StrokeStyle & { radius?: number } = {}) {
  if ((style.alpha ?? 1) <= 0.001 || w <= 0 || h <= 0) return;
  ctx.save();
  ctx.globalAlpha *= clamp(style.alpha ?? 1);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, style.radius ?? 3);
  if (style.fill) {
    ctx.fillStyle = style.fill;
    ctx.fill();
  }
  if (style.color) {
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width ?? 1.5;
    ctx.setLineDash(style.dash ?? []);
    ctx.stroke();
  }
  ctx.restore();
}

/** Diagonal hatching inside a rectangle: time spent blocked. */
export function hatch(ctx: Ctx, x: number, y: number, w: number, h: number, color: string, a = 1, spacing = 9) {
  if (w <= 0 || a <= 0.001) return;
  ctx.save();
  ctx.globalAlpha *= clamp(a);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 3);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  for (let offset = -h; offset < w; offset += spacing) {
    ctx.beginPath();
    ctx.moveTo(x + offset, y + h);
    ctx.lineTo(x + offset + h, y);
    ctx.stroke();
  }
  ctx.restore();
}

/** A soft radial glow, for energy arriving somewhere. */
export function glow(ctx: Ctx, x: number, y: number, r: number, color: string, a: number) {
  if (a <= 0.001 || r <= 0) return;
  ctx.save();
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
  gradient.addColorStop(0, alpha(color, 0.6 * clamp(a)));
  gradient.addColorStop(0.35, alpha(color, 0.18 * clamp(a)));
  gradient.addColorStop(1, alpha(color, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A labelled pill-free chip: mono text in a thin rectangle. */
export function chip(ctx: Ctx, value: string, x: number, y: number, style: { color: string; fill?: string; alpha?: number; size?: number; align?: 'left' | 'center' | 'right' }) {
  const size = style.size ?? 15;
  const width = measure(ctx, value, { size, mono: true, weight: 500 }) + 18;
  const left = style.align === 'center' ? x - width / 2 : style.align === 'right' ? x - width : x;
  rect(ctx, left, y - size - 4, width, size + 13, { color: style.color, width: 1.25, fill: style.fill ?? C.ink, alpha: style.alpha, radius: 3 });
  text(ctx, value, left + 9, y + 2, { size, mono: true, color: style.color, alpha: style.alpha, weight: 500 });
  return width;
}
