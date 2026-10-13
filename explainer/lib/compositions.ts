import type { Ctx } from './kit';
import { H, W } from './kit';
import { render as renderWide } from './scene';
import * as wideScript from './script';
import * as square from './square';
import * as mechanism from './mechanism';

/** A cut of the explainer: its frame size, clock, chapters, captions and renderer. */
export interface Composition {
  name: 'wide' | 'square' | 'mechanism';
  width: number;
  height: number;
  duration: number;
  chapters: ReadonlyArray<{ at: number; title: string }>;
  captionAt: (t: number) => string;
  chapterAt: (t: number) => { at: number; title: string };
  render: (ctx: Ctx, t: number, options?: { captions?: boolean }) => void;
}

export const compositions: Record<Composition['name'], Composition> = {
  // 16:9, 33 s: the web page on wide screens.
  wide: {
    name: 'wide', width: W, height: H, duration: wideScript.DURATION, chapters: wideScript.chapters,
    captionAt: wideScript.captionAt, chapterAt: wideScript.chapterAt, render: renderWide,
  },
  // 1:1, 30 s: social video and phones. Captions are always in the frame.
  square: {
    name: 'square', width: square.SIZE, height: square.SIZE, duration: square.DURATION, chapters: square.chapters,
    captionAt: square.captionAt, chapterAt: square.chapterAt, render: (ctx, t) => square.render(ctx, t),
  },
  // 1:1, 14 s loop, no narration: how Spidermonkey works, to sit beside a post.
  mechanism: {
    name: 'mechanism', width: mechanism.SIZE, height: mechanism.SIZE, duration: mechanism.DURATION, chapters: mechanism.chapters,
    captionAt: mechanism.captionAt, chapterAt: mechanism.chapterAt, render: (ctx, t) => mechanism.render(ctx, t),
  },
};
