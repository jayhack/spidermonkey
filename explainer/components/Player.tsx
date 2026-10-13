'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { compositions, type Composition } from '@/lib/compositions';
import { logoReady } from '@/lib/kit';

declare global {
  interface Window {
    /** For recording: seek to a time and draw that frame synchronously. */
    explainer?: { duration: number; seek: (t: number) => void; play: () => void; pause: () => void };
  }
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** Below this width the wide cut's captions are too small to read. */
const NARROW = 640;

/**
 * Plays a composition. `responsive` shows the square cut in narrow containers (phones) and
 * the wide cut elsewhere; otherwise `composition` picks one.
 */
export function Player({ composition = 'wide', responsive = false }: { composition?: Composition['name']; responsive?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const cut = compositions[responsive && narrow ? 'square' : composition];
  const cutRef = useRef(cut);
  cutRef.current = cut;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!canvas || !frame) return;
    const current = cutRef.current;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const pixels = Math.round(frame.clientWidth * ratio);
    const height = Math.round((pixels * current.height) / current.width);
    if (canvas.width !== pixels || canvas.height !== height) {
      canvas.width = pixels;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(canvas.width / current.width, 0, 0, canvas.height / current.height, 0, 0);
    current.render(ctx, timeRef.current, { captions: !(current.name === 'wide' && frame.clientWidth < NARROW) });
  }, []);

  const seek = useCallback((t: number) => {
    timeRef.current = Math.min(cutRef.current.duration, Math.max(0, t));
    setTime(timeRef.current);
    draw();
  }, [draw]);

  const setPlay = useCallback((value: boolean) => {
    if (value && timeRef.current >= cutRef.current.duration) seek(0);
    playingRef.current = value;
    setPlaying(value);
  }, [seek]);

  // Switching cuts (a phone rotating, a window resizing) keeps the place within the new clock.
  useEffect(() => { seek(timeRef.current); }, [cut, seek]);

  // The clock: advance while playing, stop at the end.
  useEffect(() => {
    let last = performance.now();
    let id = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (playingRef.current) {
        const duration = cutRef.current.duration;
        timeRef.current = Math.min(duration, timeRef.current + dt);
        if (timeRef.current >= duration) { playingRef.current = false; setPlaying(false); }
        setTime(timeRef.current);
        draw();
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [draw]);

  // Start: ?t= seeks, ?paused holds; reduced motion starts paused.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const observer = new ResizeObserver(() => { setNarrow((frameRef.current?.parentElement?.clientWidth ?? 1000) < NARROW); draw(); });
    if (frameRef.current?.parentElement) observer.observe(frameRef.current.parentElement);
    seek(Number(params.get('t') ?? 0) || 0);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!params.has('paused') && !reduced) setPlay(true);
    window.explainer = { duration: cutRef.current.duration, seek, play: () => setPlay(true), pause: () => setPlay(false) };
    void logoReady().then(draw);
    return () => observer.disconnect();
  }, [draw, seek, setPlay]);

  // Keys: space or k plays and pauses, arrows step five seconds, Home and End jump.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === ' ' || event.key === 'k') { event.preventDefault(); setPlay(!playingRef.current); }
      else if (event.key === 'ArrowLeft') seek(timeRef.current - 5);
      else if (event.key === 'ArrowRight') seek(timeRef.current + 5);
      else if (event.key === 'Home') seek(0);
      else if (event.key === 'End') seek(cutRef.current.duration);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [seek, setPlay]);

  const scrub = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    seek(((event.clientX - box.left) / box.width) * cut.duration);
  };

  const current = cut.chapterAt(time);
  const outsideCaption = cut.name === 'wide' && narrow;
  return (
    <figure className="w-full">
      <div ref={frameRef} className="relative w-full overflow-hidden rounded-lg border border-neutral-800 bg-wave-ink" style={{ aspectRatio: `${cut.width} / ${cut.height}` }}>
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full cursor-pointer"
          onClick={() => setPlay(!playingRef.current)}
          aria-label="Animated explainer: a coding agent, and an always-on System 1 that watches the machine and escalates what matters to it"
          role="img"
        />
      </div>
      {outsideCaption && <p className="mt-3 min-h-[4.5rem] text-[15px] leading-6 text-wave-paper" aria-live="polite">{cut.captionAt(time)}</p>}
      <div className="mt-3 flex items-center gap-4">
        <button
          type="button"
          onClick={() => setPlay(!playing)}
          className="w-[4.5rem] shrink-0 rounded-[3px] border border-neutral-700 px-3 py-1.5 text-sm font-semibold text-wave-paper hover:border-neutral-400"
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? 'Pause' : time >= cut.duration ? 'Replay' : 'Play'}
        </button>
        <span className="w-[6.5rem] shrink-0 font-mono text-xs tabular-nums text-neutral-400">{clock(time)} / {clock(cut.duration)}</span>
        <div
          className="relative h-8 min-w-0 flex-1 cursor-pointer touch-none"
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(cut.duration)}
          aria-valuenow={Math.round(time)}
          aria-valuetext={`${clock(time)}, ${current.title}`}
          onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); scrub(event); }}
          onPointerMove={event => { if (event.buttons & 1) scrub(event); }}
        >
          <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 bg-neutral-800" />
          <div className="absolute left-0 top-1/2 h-[3px] -translate-y-1/2 bg-wave-blue-vivid" style={{ width: `${(time / cut.duration) * 100}%` }} />
          {cut.chapters.slice(1).map(chapter => (
            <div key={chapter.at} className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-neutral-500" style={{ left: `${(chapter.at / cut.duration) * 100}%` }} />
          ))}
        </div>
        <span className="hidden w-[8.5rem] shrink-0 text-right text-xs font-semibold text-neutral-400 sm:block">{current.title}</span>
      </div>
      <nav className="mt-2 hidden flex-wrap gap-x-5 gap-y-1 sm:flex" aria-label="Chapters">
        {cut.chapters.map(chapter => (
          <button
            key={chapter.at}
            type="button"
            onClick={() => { seek(chapter.at); setPlay(true); }}
            className={`text-xs ${chapter.title === current.title ? 'text-wave-paper' : 'text-neutral-500 hover:text-neutral-300'}`}
          >
            {chapter.title}
          </button>
        ))}
      </nav>
    </figure>
  );
}
