// Render the explainer to an MP4, frame by frame: pnpm record [out.mp4]
// Needs the dev server (pnpm dev), Google Chrome and ffmpeg. COMP=square for the social cut;
// FPS and WIDTH are optional.
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const comp = ['square', 'mechanism'].includes(process.env.COMP) ? process.env.COMP : 'wide';
const fps = Number(process.env.FPS ?? 30);
const width = Number(process.env.WIDTH ?? (comp === 'wide' ? 1920 : 1080));
const height = comp === 'wide' ? Math.round((width * 9) / 16) : width;
const out = process.argv[2] ?? `spidermonkey-${comp}.mp4`;
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--hide-scrollbars'] });
const page = await browser.newPage();
await page.setViewport({ width, height, deviceScaleFactor: 1 });
await page.goto(`http://localhost:4310/frame?comp=${comp}&w=${width}`, { waitUntil: 'networkidle0' });
await page.waitForSelector('body[data-ready="1"]');
const duration = await page.evaluate(() => window.explainer.duration);

const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
const frames = Math.round(duration * fps);
for (let frame = 0; frame <= frames; frame++) {
  const data = await page.evaluate(t => {
    window.explainer.seek(t);
    return document.querySelector('canvas').toDataURL('image/png');
  }, frame / fps);
  if (!ffmpeg.stdin.write(Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'))) await new Promise(done => ffmpeg.stdin.once('drain', done));
  if (frame % (fps * 10) === 0) process.stdout.write(`${(frame / fps).toFixed(0)} s / ${duration} s\n`);
}
ffmpeg.stdin.end();
await new Promise(done => ffmpeg.once('close', done));
await browser.close();
console.log(out);
