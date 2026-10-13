import { emitKeypressEvents, type Key } from 'node:readline';
import type { DashboardState } from './types.js';

/** Move the transcript's scrollback by rows, or jump to the top or the end. Reaching the end follows new output again. */
export function scrollTranscript(state: DashboardState, by: number | 'top' | 'end') {
  const scroll = state.scroll ??= { max: 0 };
  if (by === 'end') scroll.top = undefined;
  else if (by === 'top') scroll.top = 0;
  else {
    const top = (scroll.top ?? scroll.max) + by;
    scroll.top = top >= scroll.max ? undefined : Math.max(0, top);
  }
}

/** Rows a page key moves: most of the screen, keeping a little context. */
export const pageRows = () => Math.max(1, (process.stdout.rows || 30) - 12);

/**
 * Keys for a dashboard without a composer. Arrows, PgUp/PgDn, Home/End (and j/k, g/G) scroll the
 * transcript; terminals send arrows for the scroll wheel on the alternate screen. q or Ctrl+C exits.
 */
export class ScrollKeys {
  private active = false;
  private wasRaw = false;

  constructor(private state: DashboardState, private redraw: () => void, private onExit: () => void) {}

  start() {
    if (!process.stdin.isTTY || process.env.TERM === 'dumb') return;
    this.active = true;
    this.state.scroll ??= { max: 0 };
    this.wasRaw = process.stdin.isRaw;
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', this.keypress);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    process.stdin.off('keypress', this.keypress);
    process.stdin.setRawMode(this.wasRaw);
    process.stdin.pause();
  }

  private keypress = (_text: string | undefined, key: Key | undefined) => {
    if (!key) return;
    if (key.ctrl && key.name === 'c' || key.name === 'q' && !key.ctrl) { this.onExit(); return; }
    const by = key.name === 'up' || key.name === 'k' ? -1 : key.name === 'down' || key.name === 'j' ? 1
      : key.name === 'pageup' ? -pageRows() : key.name === 'pagedown' || key.name === 'space' ? pageRows()
      : key.name === 'home' || key.name === 'g' && !key.shift ? 'top' : key.name === 'end' || key.name === 'g' && key.shift ? 'end' : undefined;
    if (by === undefined) return;
    scrollTranscript(this.state, by);
    this.redraw();
  };
}
