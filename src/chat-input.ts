import { createInterface, emitKeypressEvents, type Interface, type Key } from 'node:readline';
import type { DashboardState } from './types.js';
import { pageRows, scrollTranscript } from './scroll.js';

export class ChatInput {
  private buffer: string[] = [];
  private cursor = 0;
  private queue: string[] = [];
  private history: string[] = [];
  private historyIndex = 0;
  private draft = '';
  private closed = false;
  private waiter: ((value: string | null) => void) | undefined;
  private lines: Interface | undefined;
  private pasting = false;
  private raw = false;
  private wasRaw = false;

  constructor(private state: DashboardState, private redraw: () => void, private onExit: () => void, private plain = false) {
    state.composer = { text: '', cursor: 0, busy: false, queued: 0 };
  }

  start() {
    if (!process.stdin.isTTY || this.plain || process.env.TERM === 'dumb') {
      this.lines = createInterface({ input: process.stdin, terminal: false });
      this.lines.on('line', line => this.enqueue(line));
      this.lines.on('close', () => { this.closed = true; this.waiter?.(null); this.waiter = undefined; });
      return;
    }
    this.raw = true;
    this.state.scroll ??= { max: 0 };
    this.wasRaw = process.stdin.isRaw;
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', this.keypress);
    process.stdout.write('\x1b[?2004h');
  }

  enqueue(text: string) {
    const message = text.trim();
    if (!message) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve(message);
    } else this.queue.push(message);
    this.sync();
  }

  async next(): Promise<string | null> {
    const message = this.queue.shift();
    this.sync();
    if (message !== undefined) return message;
    if (this.closed) return null;
    return new Promise(resolve => { this.waiter = resolve; });
  }

  stop() {
    this.closed = true;
    this.waiter?.(null);
    this.waiter = undefined;
    if (this.raw) {
      process.stdin.off('keypress', this.keypress);
      process.stdin.setRawMode(this.wasRaw);
      process.stdin.pause();
      process.stdout.write('\x1b[?2004l');
      this.raw = false;
    }
    this.lines?.close();
  }

  private sync() {
    if (this.state.composer) Object.assign(this.state.composer, { text: this.buffer.join(''), cursor: this.cursor, queued: this.queue.length });
    this.redraw();
  }

  private insert(text: string) {
    const characters = Array.from(text.replace(/\r/g, '\n').replace(/[^\P{Cc}\n\t]/gu, '').replace(/\t/g, '  '));
    this.buffer.splice(this.cursor, 0, ...characters);
    this.cursor += characters.length;
  }

  private keypress = (text: string | undefined, key: Key) => {
    if (key.sequence === '\x1b[200~') { this.pasting = true; return; }
    if (key.sequence === '\x1b[201~') { this.pasting = false; this.sync(); return; }
    if (this.pasting) {
      this.insert(key.name === 'return' || key.name === 'enter' ? '\n' : text ?? '');
      this.sync();
      return;
    }
    if (key.ctrl && key.name === 'c') { this.onExit(); return; }
    if (key.ctrl && key.name === 'd' && !this.buffer.length) { this.onExit(); return; }
    if ((key.name === 'return' || key.name === 'enter') && (key.meta || key.shift)) this.insert('\n');
    else if (key.name === 'return' || key.name === 'enter') {
      const message = this.buffer.join('').trim();
      if (message) {
        this.history.push(message);
        this.historyIndex = this.history.length;
        this.buffer = [];
        this.cursor = 0;
        this.draft = '';
        this.enqueue(message);
      }
    } else if (key.name === 'left') this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === 'right') this.cursor = Math.min(this.buffer.length, this.cursor + 1);
    else if (key.name === 'home' || key.ctrl && key.name === 'a') this.cursor = 0;
    else if (key.name === 'end' || key.ctrl && key.name === 'e') this.cursor = this.buffer.length;
    else if (key.name === 'backspace') { if (this.cursor) this.buffer.splice(--this.cursor, 1); }
    else if (key.name === 'delete' || key.ctrl && key.name === 'd') this.buffer.splice(this.cursor, 1);
    else if (key.ctrl && key.name === 'u') { this.buffer.splice(0, this.cursor); this.cursor = 0; }
    else if (key.ctrl && key.name === 'k') this.buffer.splice(this.cursor);
    else if (key.ctrl && key.name === 'w') {
      let start = this.cursor;
      while (start > 0 && /\s/.test(this.buffer[start - 1])) start--;
      while (start > 0 && !/\s/.test(this.buffer[start - 1])) start--;
      this.buffer.splice(start, this.cursor - start);
      this.cursor = start;
    } else if (key.name === 'up' || key.name === 'down') {
      if (this.historyIndex === this.history.length) this.draft = this.buffer.join('');
      this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + (key.name === 'up' ? -1 : 1)));
      this.buffer = Array.from(this.history[this.historyIndex] ?? this.draft);
      this.cursor = this.buffer.length;
    } else if (key.name === 'pageup' || key.name === 'pagedown') scrollTranscript(this.state, key.name === 'pageup' ? -pageRows() : pageRows());
    else if (key.name === 'tab') this.insert('  ');
    else if (text && !key.ctrl && !key.meta) this.insert(text);
    this.sync();
  };
}
