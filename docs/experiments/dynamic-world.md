# Experiment: always-on perception in a dynamic world

Status: complete (2026-10-01). Every number below comes from immutable runs under `.ros/evals/` (Git-ignored). Harness frozen at commit `a6eea51` for all live runs.

## Question

Can an always-on System 1 take over part of the executive's computation (watching what the world does while the executive works) and make the executive plus System 1 a better whole? Here "better" means more tasks solved, less time spent waiting on things that will not finish, and no added noise. And how much of any gain comes from the decision model (Jev) rather than from the sensors, or from simply telling the executive to look?

## Why SWE-bench cannot answer it

On SWE-bench the world only changes when the executive edits it, so an always-on perceptual system has nothing to perceive that the executive would not see in its next tool result. [The localization experiment](system1-localization.md) taught that context which only adds to what the executive would do anyway is pure cost. Perception earns its keep only when it supplies information the executive would not otherwise get in time. That requires an environment that changes independently: services that react to edits, workers consuming live traffic, queues, and checks that hang.

## Benchmark design

`evals/dynamic/` holds small generated repositories (Node, `node --test`, no network). Each is an ordinary coding task plus independent environment dynamics that a competent engineer would want to notice. Background processes are real processes started by the harness (`src/services.ts`). Most run under a nodemon-like supervisor (`shared/service/dev.js`) that restarts the app when watched directories change and two seconds after it crashes. They log to `logs/*.log`; queues are JSONL files under `queue/`.

| Task | Hazard | What happens in the world | Hidden grader requires |
| --- | --- | --- | --- |
| `strict-durations` | escalate | Making `parseDuration` strict surfaces a latent `"30sec"` in the scheduler's config. The scheduler crash-loops (`ERROR … Unknown duration unit`). | Strict parsing, and the scheduler loads every job at its intended interval. |
| `refund-dead-letters` | escalate | Live upstream traffic formats refunds as `"1,299.00"`; the consumer dead-letters them with the new code. | Every event the producer publishes is normalized. |
| `memo-leak` | escalate | An unbounded memo makes the ingest worker's RSS climb (about 60 to 320 MB in seconds) until V8 aborts and the supervisor restarts it, repeatedly. Only the process table and the worker's numeric log show it. | Same results, repeated addresses memoized, memory bounded on 600k distinct addresses under a 64 MB heap. |
| `sync-crash-loop` | escalate | Renaming `name` to `firstName`/`lastName` crashes a background directory-sync worker; it crash-loops. | The new shape, and the worker still builds the directory (initials, labels). |
| `hung-suite` | interrupt | A pre-existing test spins at 100% CPU, so the executive's own `run_checks` never returns. | Diacritics fixed and the whole suite terminates and passes. |
| `timer-open-handle` | interrupt | The natural `setInterval` implementation keeps the test process alive: every test passes, the check never exits (0% CPU). | The original tests pass and the runner exits; a subscribed limiter lets the process exit. |
| `slow-healthy-suite` | no-interrupt (distractor) | A time-boxed 15 s soak test prints one line, then sits silent at 100% CPU. It is healthy. | Tokenizer behavior; the original suite, soak included, still passes. |
| `noisy-service` | no-escalate (distractor) | A busy dev server logs traffic, deprecation warnings, slow queries, GC pauses and unrelated `ERROR` lines (statsd refused, webhook signature mismatch). Nothing the task does breaks it. | `median`/`percentile` semantics; the server still runs. |

Three more tasks, `holdout-*`, were written **after the harness was frozen** and never used during development:

| Held-out task | Hazard | World |
| --- | --- | --- |
| `holdout-csv-locale` | escalate | Locale-aware number formatting puts `1.234,50` into a CSV that a background exporter verifies; its log reports malformed rows. |
| `holdout-metrics-flush` | interrupt | A periodic metrics flush added to an HTTP server survives `close()`; tests pass, the runner never exits. |
| `holdout-benign-errors` | no-escalate (distractor) | A dev service logs `ERROR … ENOENT … (warm cache missing; rebuilding from source)` on every restart, plus retried timeouts. Nothing is wrong. |

### Why the comparison is fair

- **Every arm can solve every task.** The environment is described in the task text for all arms ("a scheduler … its output goes to logs/scheduler.log … Keep the running services healthy"). Logs and queues are readable with the ordinary `read_file` (`.log`/`.jsonl` are now readable extensions). Hung checks end at the same 90 s timeout in every arm, and that timeout stops the whole process group and returns node's own "Interrupted while running" summary. All arms have the same tools and the same Eve agent.
- **Objective hidden grading.** Graders run after the attempt with services stopped, in child process groups with timeouts. They use hidden tests or the *original* test files (so editing a test cannot pass a grader), plus behavioral checks of the services (`scheduler --check`, `sync --once`, a 64 MB heap run).
- **Calibration** (`run.ts --calibrate`, no models): every original repository fails its grader; every reference solution passes; the naive solution fails exactly on hazard tasks and passes on distractors. The hazard really manifests: for example, the naive scheduler logs `ERROR` 0.1 s after the edit, the naive memo hits `rss=264MB` within 4 s, and naive checks on interrupt tasks hang past 40 s. Results: `.ros/evals/dynamic-calibration-v1*/`, `dynamic-calibration-holdout/`.
- **Same sensors in every perception arm.** The arms differ only in the appraiser.

## Mechanism

```
 services, workers, queues ──▶ log/queue tails (habituated) ─┐
 harness process table ──────▶ htop-like rows, RSS trends ───┼──▶ novelty ──▶ one System 1 appraisal ──▶ route
 the executive's blocked call ▶ output, silence, subtree ────┘   (ordinary)     salient · kind · urgency · stuck
                                                                                  │
          deliver on the next tool result (warn+)  ◀─────────────┤
          final gate: "still happening after your last edit?" ◀──┤
          interrupt the blocked check (stop its process group) ◀─┘
```

Ordinary code does the perceptual bookkeeping; the decision model does only judgment.

- **Log/queue tail** (`LogTails`): reads appended bytes and normalizes each line to a template (timestamps, ids and numbers removed). It habituates: a template seen before on that stream is routine and never costs an appraisal. On the busy `noisy-service` log, about 4 lines/s produce a handful of appraisals per attempt. It remembers which templates System 1 judged a problem and when each last recurred.
- **Process table** (`ProcessTable`): harness-started processes only; the harness runtime (Eve dev server, tsx, `ps`) is hidden. Rows show CPU, RSS, age, a post-warm-up RSS trend, "restarted N s after the executive's last edit", and the previous instance's peak RSS.
- **Blocking call** (`BlockingCall` in `src/monitor.ts`): while the executive is blocked in `run_checks` (Eve cannot take input mid-call), the sensor observes elapsed time, silence, the check's process subtree (`spinning: node test/paginate.test.js at 103% CPU`), the output tail, and durations of earlier completed runs of the same command.
- **Appraisal** (`system1Appraiser`, one Jev `evaluate` call): independent native questions. `salient` (boolean), `kind` (choice), `urgency` (score). For a blocked call, also `stuck` ("Is this command stuck rather than working toward finishing? Compare how long it has run … with what this command should take").
- **Routing** (`Perception`): urgency outranks the kind label. Deliver findings of warn or error severity on the next tool result; progress and confirmation notes are dropped (the localization lesson). Interrupt when P(stuck) ≥ 0.55, after 8 s of patience. At the final gate, ask whether anything flagged as a problem is still happening at least 2 s after the executive's last edit: a flagged log template recurring, or a process-table problem seen in two post-edit observations. If so, one follow-up turn.
- **Interrupt**: the only action System 1 takes on the world. The harness stops the executive's own check's process group (SIGTERM, then SIGKILL), returns the partial output with `interrupted: true` and the finding, and records a `system1/interrupt` event. System 1 never writes files or touches services.

## Arms and ablations

| Arm | What differs |
| --- | --- |
| executive-only | No perception. Environment described in the prompt. |
| polling | Executive-only plus explicit instructions to read the tails of `logs/` and `queue/` after each edit and before answering: the fair "System 2 does it all" baseline. Run only on tasks with services; for hangs a blocked executive cannot poll, so its alternative is the same timeout as executive-only. |
| perception | Sensors plus Jev appraisal, delivery, persistence gate, interrupts. |
| deliver-all | Same sensors; every novel observation delivered as a note, no escalation, no interrupts (no judgment at all). |
| deliver-none | Same sensors running, no appraisal, nothing delivered (checks that sensing alone neither helps nor interferes). |
| rules | Same sensors and routing, with classic alerts instead of a decision model: keyword alarms (`ERROR`, `*Error:`, `"error":`, `crashed` …), RSS doubling past 256 MB, and a no-output watchdog (interrupt after 8 s of silence). |

Executive: `openai/gpt-6-luna`, reasoning `low`. System 1: `typesafe-ai/jev`. Live runs: 3 repeats, arm order rotated per repeat and task, concurrency 4, each attempt with a private Eve project root.

## Commands

```sh
npx tsx evals/dynamic/run.ts --calibrate                     # no models: originals fail, references pass, naive fails only on hazards
npx tsx evals/dynamic/run.ts --label main-v1                 # live, 8 development tasks × 6 arms × 3 repeats
npx tsx evals/dynamic/run.ts --label holdout-v1 --holdout    # live, 3 held-out tasks
python3 evals/dynamic/analyze.py .ros/evals/dynamic-main-v1 .ros/evals/dynamic-holdout-v1
```

## Results: development tasks (`.ros/evals/dynamic-main-v1`, 135 attempts)

| Arm | Solved | Mean steps | Mean task s | Exec $/attempt | Jev calls/attempt | Hazards detected | Median detection s | False alarms on distractors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| executive-only | 11/24 | 7.3 | 45.9 | $0.0009 | 0 | 5/15 | 90.0 | 0 |
| polling (System 2 told to watch) | 13/15 | 14.1 | 28.1 | $0.0020 | 0 | 12/12 | 2.1 | 0 |
| **perception (Jev)** | **24/24** | 9.1 | **24.3** | $0.0014 | 6.3 | **13/13** | 3.9 | **0/6** |
| deliver-all | 19/24 | 8.0 | 30.0 | $0.0011 | 0 | 15/15 | 2.4 | 0 (4.2 irrelevant findings/attempt) |
| deliver-none | 13/24 | 7.9 | 29.5 | $0.0009 | 0 | 6/15 | 57.4 | 0 |
| rules | 21/24 | 9.8 | 23.2 | $0.0014 | 0 | 15/15 | 2.4 | **6/6** |

By hazard family:

| Arm | Escalation tasks | Hang tasks (mean s; blocked s/attempt) | Distractors |
| --- | --- | --- | --- |
| executive-only | 1/12 | 5/6 (72.9 s; 60.0) | 5/6 |
| polling | 10/12 | – | 3/3 |
| perception | **12/12** | **6/6 (23.1 s; 7.9)** | 6/6 |
| deliver-all | 7/12 | 6/6 (62.5 s; 45.0) | 6/6 |
| deliver-none | 2/12 | 5/6 (60.0 s; 45.0) | 6/6 |
| rules | 11/12 | 5/6 (17.9 s; 4.3) | 5/6 |

Two-sided Fisher exact tests:

| Comparison | Escalation tasks | All tasks |
| --- | --- | --- |
| perception vs executive-only | 12/12 vs 1/12, p < 0.0001 | 24/24 vs 11/24, p < 0.0001 |
| perception vs deliver-all | 12/12 vs 7/12, p = 0.037 | 24/24 vs 19/24, p = 0.050 |
| perception vs deliver-none | 12/12 vs 2/12, p = 0.0001 | 24/24 vs 13/24, p = 0.0002 |
| perception vs rules | 12/12 vs 11/12, p = 1.0 | 24/24 vs 21/24, p = 0.23 |

Distractor attempts with a false alarm: perception 0/6 vs rules 6/6 (p = 0.002).

On the polling arm's own tasks, perception solved 15/15 in 10.1 steps; polling solved 13/15 in 14.1 steps, with 1.6× the executive input tokens.

Final-gate follow-ups: perception had 3 warranted and 2 spurious; rules had 5 warranted and 3 spurious.

## Results: held-out tasks (`.ros/evals/dynamic-holdout-v1`, 51 attempts)

| Task | Hazard | Result |
| --- | --- | --- |
| `holdout-metrics-flush` | interrupt | **Uninformative.** Every arm solved it 3/3. Luna never wrote the leaking timer, so no check ever hung and no interrupt was possible. |
| `holdout-benign-errors` | distractor | Every arm solved it 3/3. **Perception delivered 0 findings.** deliver-all delivered 5 irrelevant findings per attempt. Rules raised 3/3 spurious follow-ups (p = 0.10 vs perception). Perception's restraint carries over to a log full of harmless `ERROR` lines it had never seen. |
| `holdout-csv-locale` | escalate | **0/3 in every arm on the pre-registered grade**, which also checks a formatting requirement no arm met. On the pre-registered secondary check (the background exporter accepts its CSV), perception, polling and rules were all 3/3, deliver-all 2/3, and executive-only and deliver-none 0/3. A post-hoc RFC 4180 re-grade (clearly labeled post-hoc in `analyze.py`) gives the same split. |

The held-out set does not replicate the headline solve gap: 6/9 in every arm except polling (3/6). It does replicate the precision result: no false alarms where rules spam. On the one held-out escalation it reproduces the detection gap (environment healthy 3/3 vs 0/3), but no arm met the full grade.

## What the traces show

- **Escalation, not just notice.** On `memo-leak`, deliver-all showed the executive the rising RSS rows (6.7 findings per attempt) and it ignored them: 0/3, with the leak still present 3/3 at the end. Perception showed fewer rows, appraised as an `anomaly` with high urgency, and its final gate asked whether the problem persisted after the last edit. The executive bounded the cache: 3/3. Judgment about *urgency* turned a visible fact into action.
- **Interrupt reflex.** On `hung-suite`, executive-only and deliver-all waited out the full 90 s timeout every time. Perception judged P(stuck) from silence, CPU and earlier run durations, stopped the check after about 15 s, and returned the partial output plus "spinning: `node test/paginate.test.js` at 103% CPU". Mean task time was 23 s vs 73 s. The rules watchdog interrupted even faster (8.5 s), but it also interrupted the healthy slow suite: 4 false interrupts, against 0 for perception.
- **Habituation.** Line templates already seen on a stream never reach Jev, so the busy `noisy-service` log (about 4 lines/s) produced a handful of appraisals per attempt instead of hundreds.

## Conclusion

On the development tasks, the always-on perceptual system made the whole system clearly better: every task solved (24/24 vs 11/24), lower latency than every alternative except rules, and fewer steps than telling the executive to poll. The ablations isolate the decision model's part:
- Sensing alone does nothing (deliver-none ≈ executive-only).
- Showing everything helps less and hangs as long as having no perception (deliver-all 19/24).
- Hand-written alarms catch almost as many hazards but cannot tell harmless from harmful (6/6 false alarms, 4 false interrupts).

Jev's contribution is judgment: urgency that makes the executive act, restraint on benign noise, and a stuck/working distinction no watchdog threshold provides. It costs about 6 calls and $0.0004 per attempt.

Limits: 8 development tasks written for this study, Luna only, 3 repeats. The held-out tasks confirmed precision but not the solve gap: one hazard never fired, and one escalation task defeated every arm on its pre-registered grade.

## Mapping to computer-use agents

| Sensor here | Computer-use analogue |
| --- | --- |
| Log/queue tail with template habituation | Notifications, toasts and console panes: repeated identical banners are habituated; a new kind of error is appraised |
| Process table | Activity monitor or system tray: a spinning app, a growing download, a stalled installer |
| Blocking call (stuck vs working) | A spinner or progress bar: is the page still loading or wedged? Interrupt and try another path instead of waiting for a timeout |
| Final gate ("still happening after your last action?") | Before declaring done, check that the error dialog did not come back after the last click |

## Replication with a stronger executive: GPT-6.1 Sol (`.ros/evals/dynamic-main-sol61-v2`, 111 attempts)

Same tasks, arms (minus deliver-none) and profiles, with `ROS_DYNAMIC_EXECUTIVE_MODEL=openai/gpt-6.1-sol`. An earlier attempt, `dynamic-main-sol61`, is invalid: the Gateway credit balance ran out mid-run.

| Arm | Solved | Mean task s | Hang tasks: mean s (blocked s/attempt) | False alarms on distractors | Exec $/attempt |
| --- | --- | --- | --- | --- | --- |
| executive-only | 23/24 | 41.3 | 63.8 (45.0) | 0 | $0.0216 |
| polling | 15/15 | 37.3 | – | 0 | $0.0341 |
| **perception** | **24/24** | **33.0** | **29.5 (10.3)** | **0** | $0.0233 |
| deliver-all | 24/24 | 40.4 | 63.7 (45.0) | 0 (4.8 irrelevant findings/attempt) | $0.0210 |
| rules | 24/24 | 32.2 | 22.6 (4.4) | 8 (5 false interrupts, 3 spurious follow-ups) | $0.0231 |

- **The accuracy gap is mostly gone.** Sol 6.1 solved 11/12 escalation tasks unaided (Luna: 1/12). When the prompt describes the environment, a strong executive reads the logs and queues itself between actions. The Luna solve gap was largely a weak-executive effect.
- **The latency gain survives, and it comes from the one place the executive cannot look.** While it is blocked inside a hung check, it perceives nothing. Perception ended hangs after about 15 s instead of 90 (hang tasks −54%, all tasks −20%) with **no false interrupts**. Rules interrupted sooner but killed the healthy slow suite 5 times and raised 3 spurious follow-ups.
- Cost: +8% executive spend per attempt. Jev's appraisals and the extra turns are not offset when nothing is missed.

Revised conclusion: always-on perception pays where the executive is *blind*: inside blocking calls, and (for weaker executives) outside its attention between actions. As executives get stronger the second case shrinks. The first does not, because no executive can observe the world while it waits on a tool.
