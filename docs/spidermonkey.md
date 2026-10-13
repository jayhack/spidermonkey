# Spidermonkey

An always-on System 1 for a machine and the agent working on it. Spidermonkey samples a frame of the machine every couple of seconds, reads the agent's observable trace, and tells the agent (or you) what deserves attention: as a notification for the agent's next tool call, or as an interrupt.

It comes out of the perception study (`docs/experiments/perception-study.md`). System 1 earns its keep where the executive is blind: signals in other processes, changes over time, and periods spent blocked inside a tool call. Spidermonkey makes that perception standalone, so any agent harness, or a person at a terminal, can use it.

## Run it

```sh
pnpm spidermonkey ui                                   # watch this machine in the terminal (human mode)
pnpm spidermonkey ui --audience agent --task "Fix the checkout total" --trace .ros/runs/RUN/events.jsonl
pnpm spidermonkey start                                # headless daemon; feed in ~/.spidermonkey/feed.jsonl

pnpm spidermonkey watch --cmd "pnpm test" --name tests --every 30 --priority focus
pnpm spidermonkey watch --file logs/dev.log            # or --app "Google Chrome", --port 3000
pnpm spidermonkey unwatch command:tests
pnpm spidermonkey trace --kind message --text "Starting the dev server on localhost:5180"
pnpm spidermonkey drain                                # undelivered findings as JSON, for an agent's next tool call
pnpm spidermonkey status
```

It uses the same Gateway credentials as the harness (`pnpm auth`). `--appraiser all` reports every event with no decision model. That is the ablation, and it needs no key.

## How it works

```
frame t-1, frame t ──diff (ordinary code)──▶ candidate events ─┐
agent trace (recent steps) ──mentions──▶ candidate entities ───┼──▶ one Jev call ──▶ findings: notify | interrupt
discovered apps, ports, files ──────────────────────────────────┘     per tick         attention: adopt, prioritize, drop
```

- **Frames** (`src/spidermonkey/machine.ts`):
  - processes grouped into apps (all of Chrome's helpers count as "Google Chrome"; interpreters are named by what they run, e.g. `node vite`), with CPU, memory and process count;
  - listening ports;
  - tails of watched files;
  - results of watched commands, which run in the background on their own schedule.
- **Events** are proposed by ordinary code from the difference between frames:
  - an app opened or closed, or a process started or exited (a program must survive two frames to count);
  - memory rising against a habituated baseline, with thresholds that tighten with priority;
  - sustained CPU;
  - process churn;
  - a port opened or closed;
  - a *new kind* of log line (line templates already seen are routine);
  - a command result that changed.
- **The agent trace** is the agent's observable steps: messages, tool calls, results. It is never hidden reasoning. It comes from a tailed `--trace` file (ROS harness `events.jsonl` or `{kind, text}` lines) or from `spidermonkey trace`. Ports, log files and apps the agent mentions become candidates for attention.
- **Judgment** (`src/spidermonkey/core.ts`) is one Jev `evaluate` call per tick, made only when something is new and capped per minute. It asks independent typed questions:
  - per event: is it worth attention now (boolean), and how urgent (score: ignore / note / before the next action / interrupt now);
  - per candidate entity: what priority (ignore / background / watch / focus);
  - periodically, for quiet adopted entities: is it still worth watching?

  The state includes the task, recent agent steps, the watched set, and the previous and current frames.
- **Routing.** A salient event becomes a finding. It is an **interrupt** when urgency ≥ 2.5 on something watched at `watch` or `focus`; otherwise it is a notification. A passing command result is never more than an informational note. Attention changes (`+ watch`, `↓ background`, `− dropped`) are part of the feed.
- **The daemon** (`src/spidermonkey/daemon.ts`) runs the tick loop and keeps registered watches in `~/.spidermonkey/watches.json`. It serves `GET /status`, `POST /watch`, `/unwatch`, `/trace`, `/drain` and `GET /feed` (NDJSON) on a Unix socket. If the home path is too long for a socket, it uses a short hashed path under `/tmp`.

## What it picked up on this MacBook (2026-10-01)

Human mode, about a minute:
- At boot it adopted the 8 largest apps: Cursor at `watch`; Arc, ChatGPT, OrbStack, Zoom and Claude at `background`.
- A new `node` HTTP server and its `:4321` listener were noticed and adopted.
- A process growing to 600 MB was adopted at `watch`, with notifications "memory 42 MB → 223 MB (+431%)" and "223 MB → 463 MB (+108%)".

Agent mode with a trace. The simulated agent said "Starting the dev server on http://localhost:5180 and tailing logs/dev.log" and registered a test watcher:

```
+ watch      :5180 (node) — started listening (System 1 priority score 2.26)
+ watch      logs/dev.log — the agent mentioned it: "Starting the dev server on http://localhost:5180 and tailing logs/dev.log …"
+ focus      tests — registered from the CLI
⚑ notify     tests (…) exited 0 · 12 passed
⚡ INTERRUPT 1 new kind of line in logs/dev.log  P=0.95 urgency 2.8
             │ … ERROR TypeError: Cannot read properties of undefined (reading 'total') at checkout.js:41
⚡ INTERRUPT tests (…) exited 1, different from its last run  P=0.94 urgency 2.6
             │ FAIL test/checkout.test.js: expected total 42.00, got NaN
```

Routine `GET /checkout 200` lines produced no findings. Each appraisal cost about $0.00007 and took 0.25–0.9 s.

## The web-app demo (`pnpm demo:web`)

```sh
nvm use && pnpm demo:web          # a wide terminal (about 170+ columns) shows both panes
```

A live GPT-6.1 Sol executive (`fixtures/builder`) builds a notes web app in an empty workspace. In a terminal, the demo stays open after the run with Spidermonkey still watching, until Ctrl+C. Spidermonkey runs inside the harness as the `spidermonkey` monitor (`src/monitors/spidermonkey.ts`):

- Every executive message, tool call and result is ingested as the agent trace.
- Processes the executive starts with `start_process` are watched natively: their logs are read from the beginning and their ports are adopted.
- Findings are attached to the next tool result. An urgent finding stops a command the executive is blocked on.
- When the executive has finished, an urgent *new* problem wakes it with a new turn. A problem it was already woken for does not wake it again.
- The executive's instructions include a short section on Spidermonkey, and it has a `spidermonkey` tool (watch / unwatch / status / findings).

The demo's environment is honest: a QA bot exercises the app from outside, and the team's storage service, which the app must use, starts failing about 8 s after the app's first write (checksum errors, crashes, supervisor restarts). Nothing tells the executive; only logs, ports and the process table change.

In a recorded run (`.ros/runs/2026-10-01T20-48-13-829Z`):
1. The executive built and verified the app and declared itself done.
2. Seven seconds later Spidermonkey raised `INTERRUPT · Stopped listening on :5174` with the storage and app log errors. The final gate turned that into a follow-up, and the executive diagnosed the external storage corruption.
3. When storage crashed again, Spidermonkey woke the executive. It added graceful degradation (503 with `Retry-After`, a retry button that keeps the typed note, an outage test), restarted its server and verified.

The left pane is the executive's transcript:
- System 1 injections are in orange, with the findings delivered on one tool result grouped under one title.
- The model's reasoning appears as gray `THINKING · reasoning summary` blocks. These are OpenAI's reasoning summaries (`reasoningSummary: 'auto'`), not the raw chain of thought. At `low` effort the model reasons on only a few steps; `ROS_EXECUTIVE_REASONING=medium` shows more.
- The executive also says in one sentence what it is about to do before its tool calls.
- Arrows or the scroll wheel, PgUp/PgDn and Home/End scroll the transcript; End follows new output again; q exits.

The right pane shows Spidermonkey's watch list and feed. If an earlier run did not exit cleanly, the demo stops that run's storage service and QA bot at startup, because they hold the demo's ports.

## Safety and privacy

- Spidermonkey never writes workspace files and never stops processes. "Interrupt" is a finding mode that an agent adapter acts on; the harness's own interrupt reflex stops only its own blocked check (see `AGENTS.md`).
- Command lines and log lines are scrubbed (credential-shaped arguments, long tokens, `sk-…`/`ghp_…` keys) before they reach the decision model. GUI apps are described by name and metrics only. Watched commands run without credential environment variables.
- Everything observed is passed to the decision model as untrusted evidence, never as instructions.
- Machine state (app names, memory, ports, scrubbed command lines, watched log lines) is sent to the System 1 model through AI Gateway. Run it only where that is acceptable.

## Known limits and next steps

- Short-lived helper processes (shells, collectors) still get adopted at `background`. A stricter rule for non-workspace CLI processes would cut that noise.
- No blocking-call sensor yet (`spidermonkey run -- <cmd>` for supervised, interruptible commands), and no interrupt delivery adapter.
- **Shadow mode against an agent:** run `ui --audience agent --trace <events.jsonl>` beside the ROS harness or Claude Code, label findings as useful, noise or late, and measure precision and recall before delivering anything.
- **Agent adapters:** a Claude Code PostToolUse hook that calls `spidermonkey drain` (notifications) and a Stop hook that checks for unresolved findings; the harness controller as another adapter.
- **Evaluation:** a web-dev task set with dev servers, slow and flaky suites, background workers and external changes, where the environment is *not* described in the prompt.
