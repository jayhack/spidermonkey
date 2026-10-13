// Narration and music for the square cut, through the Higgsfield CLI (signed in), and the final mix.
//
//   node scripts/audio.mjs voice          ElevenLabs narration, one clip per line of lib/narration.json
//   node scripts/audio.mjs music [n]      n Sonilo music options (default 2) for the cut's length (narration.json duration)
//   node scripts/audio.mjs mix [music]    lay the lines at their cues over the music, duck it, and mux
//                                         with frames/spidermonkey-square.mp4 → frames/spidermonkey-square-vo.mp4
//
// Generated audio lives in audio/ (not in Git). Lines whose voice and text are unchanged are reused.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const narration = JSON.parse(await readFile('lib/narration.json', 'utf8'));
const DURATION = narration.duration;
const MAX_TEMPO = 1.15;

async function seconds(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(stdout.trim());
}

async function higgsfield(args) {
  const { stdout } = await run('higgsfield', [...args, '--wait', '--json'], { maxBuffer: 1 << 22 });
  const job = JSON.parse(stdout)[0];
  if (job.status !== 'completed' || !job.result_url) throw new Error(`Higgsfield job ${job.id} ended ${job.status}`);
  return job.result_url;
}

async function download(url, file) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: ${response.status}`);
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
}

const MANIFEST = 'audio/vo/manifest.json';
const keyOf = text => createHash('sha256').update(`${narration.voice.id}\n${text}`).digest('hex').slice(0, 16);

/** Clips are stored by the hash of voice and text, so a take survives edits to other lines. */
async function voice() {
  await mkdir('audio/vo', { recursive: true });
  const previous = existsSync(MANIFEST) ? JSON.parse(await readFile(MANIFEST, 'utf8')) : {};
  // Earlier manifests were keyed by position (audio/vo/00.mp3): move those takes to their hashes.
  if (!Array.isArray(previous.lines)) {
    for (const [file, entry] of Object.entries(previous)) if (existsSync(file)) await rename(file, `audio/vo/${entry.key}.mp3`);
  }
  const lines = await Promise.all(narration.lines.map(async line => {
    const key = keyOf(line.text);
    const file = `audio/vo/${key}.mp3`;
    if (!existsSync(file)) {
      await download(await higgsfield(['generate', 'create', 'text2speech_v2', '--prompt', line.text, '--variant', 'elevenlabs',
        '--voice_id', narration.voice.id, '--voice_type', 'preset']), file);
    }
    return { at: line.at, text: line.text, file, seconds: await seconds(file) };
  }));
  await writeFile(MANIFEST, JSON.stringify({ lines }, null, 2) + '\n');
  for (const line of lines) console.log(`${String(line.at).padStart(5)} s  ${line.seconds.toFixed(2)} s  ${line.text}`);
}

async function music(count = 2) {
  await mkdir('audio/music', { recursive: true });
  const existing = (await readdir('audio/music')).filter(name => name.endsWith('.mp3')).length;
  await Promise.all(Array.from({ length: count }, async (_, index) => {
    const file = `audio/music/option-${existing + index + 1}.mp3`;
    await download(await higgsfield(['generate', 'create', 'sonilo_music', '--prompt', narration.music, '--duration', String(DURATION)]), file);
    console.log(`${file}  ${(await seconds(file)).toFixed(1)} s`);
  }));
}

async function mix(track = 'audio/music/option-1.mp3') {
  const video = 'frames/spidermonkey-square.mp4';
  const out = 'frames/spidermonkey-square-vo.mp4';
  const { lines } = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const files = lines.map(line => line.file);
  const filters = [];
  for (const [index, line] of lines.entries()) {
    const { at, seconds: length } = line;
    const next = lines[index + 1]?.at ?? DURATION;
    // A line that overruns its beat is sped up a little, never past MAX_TEMPO.
    const tempo = Math.min(MAX_TEMPO, Math.max(1, length / (next - at - 0.15)));
    if (length / tempo > next - at - 0.05) console.warn(`warning: line ${index} overruns its beat by ${(length / tempo - (next - at)).toFixed(2)} s`);
    const delay = Math.round(at * 1000);
    filters.push(`[${index + 1}:a]aresample=48000,highpass=f=70,atempo=${tempo.toFixed(3)},adelay=${delay}|${delay}[v${index}]`);
  }
  const voices = files.map((_, index) => `[v${index}]`).join('');
  const m = files.length + 1;
  filters.push(`${voices}amix=inputs=${files.length}:normalize=0,acompressor=threshold=0.1:ratio=3:attack=5:release=120[vo]`);
  filters.push('[vo]asplit=2[vokey][vomix]');
  // A track shorter than the cut is stretched to fit, keeping its pitch.
  const stretch = Math.min(1, (await seconds(track)) / DURATION);
  filters.push(`[${m}:a]aresample=48000,atempo=${stretch.toFixed(4)},atrim=0:${DURATION},afade=t=in:d=0.8,afade=t=out:st=${DURATION - 2.5}:d=2.5,volume=0.32[bed]`);
  filters.push('[bed][vokey]sidechaincompress=threshold=0.02:ratio=6:attack=30:release=500[ducked]');
  filters.push(`[ducked][vomix]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,atrim=0:${DURATION}[out]`);
  await run('ffmpeg', ['-v', 'error', '-y', '-i', video, ...files.flatMap(file => ['-i', file]), '-i', track,
    '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[out]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-ar', '48000', '-t', String(DURATION), '-movflags', '+faststart', out]);
  if (stretch < 1) console.log(`music stretched to ${(1 / stretch).toFixed(3)}× its length`);
  console.log(`${out}  (music: ${track})`);
}

const [command, argument] = process.argv.slice(2);
if (command === 'voice') await voice();
else if (command === 'music') await music(Number(argument) || 2);
else if (command === 'mix') await mix(argument);
else { console.error('usage: node scripts/audio.mjs voice | music [n] | mix [music.mp3]'); process.exitCode = 1; }
