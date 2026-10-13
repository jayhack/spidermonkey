'use client';

import { useEffect, useRef } from 'react';
import { compositions } from '@/lib/compositions';
import { logoReady } from '@/lib/kit';

/** One frame, for stills and video export: /frame?t=42, with ?comp=square and ?w=1080. */
export function Frame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const params = new URLSearchParams(window.location.search);
    const name = params.get('comp');
    const cut = compositions[name === 'square' || name === 'mechanism' ? name : 'wide'];
    const width = Number(params.get('w')) || cut.width;
    canvas.width = width;
    canvas.height = Math.round((width * cut.height) / cut.width);
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;
    const draw = (t: number) => { ctx.setTransform(canvas.width / cut.width, 0, 0, canvas.height / cut.height, 0, 0); cut.render(ctx, t); };
    void logoReady().then(() => {
      draw(Number(params.get('t')) || 0);
      window.explainer = { duration: cut.duration, seek: draw, play: () => {}, pause: () => {} };
      document.body.dataset.ready = '1';
    });
  }, []);
  return <canvas ref={canvasRef} style={{ display: 'block' }} />;
}
