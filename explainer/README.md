# Spidermonkey explainer

A 33-second animated explainer of Spidermonkey: a coding agent that works one step at a time and cannot keep track of a busy machine; the human split between executive function and perception; and a fast decision model on top of the machine's signals that escalates what matters to the agent. Next.js with [Wave Kit](https://wave-kit.dev) (`@jayhack/wave-kit`) for tokens, type and page shell.

```sh
pnpm install
pnpm dev                 # http://localhost:4310
```

The animation is drawn on a canvas as a pure function of time, so it scrubs exactly and records deterministically. There are two cuts (`lib/compositions.ts`):

- **wide** (16:9, 33 s): `lib/script.ts` for chapters and captions, `lib/scene.ts` for the frames. The page shows it on wide screens.
- **square** (1:1, 34 s, `lib/square.ts`): for social video and phones. It shows shapes rather than text so it reads with the sound off, in a brighter blue and yellow than the page: tool calls are a verb and a bar, processes are lanes in a box, events are sparkles, and the bottom quarter is the subtitles'. It opens on the point ("A System 1 for coding agents"); the agent works, its tool calls bring the machine alive, and polling it costs step after step (each check lights the lane it inspects). Then Spidermonkey takes over the processes box and shows its work as a decision model does it: it links sparkles of one kind into a pattern, boxes the region, and categorizes it. Routine patterns flash gray; the storage crash turns red and interrupts the agent, its recovery turns orange and becomes a note. It closes on a Tron-style title. The page shows it below 640 px; `/square` previews it alone.
- **mechanism** (1:1, 14 s loop, no narration, `lib/mechanism.ts`): how Spidermonkey works, to sit beside a post. Input streams from the machine (memory, processes, ports, logs, tests) are sampled every tick; one Jev call classifies what each stream did, with its probability; a memory spike becomes a note and a dead process an interrupt, escalated to the agent. The agent also registers a stream of its own ("watch npm test", with guidance), which is classified like the rest. Record it with `COMP=mechanism pnpm record`.
- `lib/kit.ts`: drawing primitives and the Wave Kit palette roles: paper for labels, blue for observations, orange for System 1, red for interventions, sky for the executive, neutral for guides.
- `components/Player.tsx`: playback, scrubbing, chapters and keys (space, ←/→, Home/End). `?t=42` seeks and `?paused` holds. Below 640 px the captions move under the frame as text.

## Stills and video

With `pnpm dev` running:

```sh
pnpm stills 7 16.5 26.2                # full-resolution PNGs in frames/
pnpm record frames/explainer.mp4      # wide: 1920×1080, 30 fps MP4 (needs Google Chrome and ffmpeg)
COMP=square pnpm record               # square: 1080×1080 → spidermonkey-square.mp4
COMP=square pnpm stills 10 21         # square stills
```

`/frame?t=42&w=1920` renders a single frame; add `&comp=square` for the square cut.

## Voiceover and music

The square cut's narration is `lib/narration.json`: each line's cue, its text (the captions show the same words), the ElevenLabs voice, and the music prompt. Audio comes from the Higgsfield CLI (`higgsfield auth login` first) and lands in `audio/`, which Git ignores.

```sh
pnpm audio voice                        # one ElevenLabs clip per line; unchanged lines are reused
pnpm audio music 2                      # two Sonilo music options for the cut's length
COMP=square pnpm record frames/spidermonkey-square.mp4
pnpm audio mix audio/music/option-1.mp3 # → frames/spidermonkey-square-vo.mp4
```

Takes are stored by the hash of voice and text, so editing one line regenerates only that line. The mix starts each line at its cue (speeding a line up to 1.15× only if it would overrun its beat), stretches a music track shorter than the cut, ducks it under the voice, and normalizes to −14 LUFS for social platforms. To change the voice, put another id from `higgsfield voices list` in `narration.json` and run `voice` and `mix` again.

## Deploy to Vercel

Create a Vercel project from this repository with **Root Directory** set to `explainer`. Vercel detects Next.js; every route is static. Add the domain under Project → Settings → Domains.

## Sources for the numbers

- 15 s instead of 90 s, −54% on hang tasks, 0 false interrupts: the GPT-6.1 Sol replication in `docs/experiments/dynamic-world.md`.
- $0.003 for System 1 beside $0.20 for the executive: the recorded web-app demo run in `docs/spidermonkey.md`.
- ~$0.00007 and 0.25–0.9 s per appraisal: `docs/spidermonkey.md`.
