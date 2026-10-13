# Study: an always-on System 1 as the executive's perceptual system

Status: in progress (started 2026-09-30, branch `s1-perception`).

## Claim under test

> We can build an always-on System 1 that hands some of the important computation to a cheap decision model, and the result is a better cognitive whole.

"Better" means at least one of these, without losing official solves: fewer executive steps, lower latency, more solves, or less wasted work, such as waiting on a hung command or acting on stale evidence. The goal is a general, extensible architecture with modest, real gains. Tuning to a handful of benchmark tasks is out of scope.

## Architecture

```
            ┌──────────── sensors (plain code; always on) ────────────┐
 world ───▶ │ tool results · tests after edits · lint / diff · logs · │
            │ process table · files and queues · (screens for CUA)    │
            └────────────────────────────┬────────────────────────────┘
                                         │ Observation {stream, content, facts, editRevision}
                                         ▼
                              novelty filter (hash per stream; plain code)
                                         │ novel only
                                         ▼
                      System 1 appraisal (Jev, typed questions, native P):
                  salient? · kind (failure/regression/anomaly/progress/…) · urgency
                                         │
                                         ▼
       attention router ─▶ drop · note · escalate · dive (bounded read-only) · interrupt · gate
                                         │
                                         ▼
          delivery at the executive's next action boundary (tool result),
          answering run_checks from a current observation, or a final-gate follow-up
```

- `src/monitor.ts`: hooks the controller calls. `intercept` answers a tool call from an observation. `transform` rewrites a result, for attention or dives. `afterTool` observes a call. `tick` runs on a timer. `settle` waits for in-flight work. `finalGate` can ask for a follow-up turn after the answer.
- `src/perception.ts`: the domain-agnostic core. Sensors produce `Observation`s. Every observation from every sensor gets the **same** three System 1 questions, asked relative to the task and the executive's recent actions. Routing depends only on the appraisal, so adding a sensor never adds decision logic.
- `src/monitors/perception.ts`: configurable sensors. Command sensors run on edit, on a tick, or at start, with debounce and supersession by newer edits. The process sensor watches harness descendants with bucketed novelty keys. The tests sensor can answer `run_checks` when it has observed the same command at the current edit revision.
- Ablations: `appraiser: "deliver-all"` pushes every novel observation, as if perception had no judgment. `appraiser: "deliver-none"` keeps sensors running but never tells the executive. Comparing them isolates what the decision model contributes.
- Safety: System 1 never edits workspace files. Sensor commands are profile-configured. Observations are untrusted evidence in every question. Findings contain observed text and native probabilities, never generated reasoning.

The executive cannot be interrupted during a model call, because Eve streams one call at a time. Perception is therefore delivered at action boundaries, while a blocking action is running (see the interrupt hypothesis), or through a follow-up turn.

## Lessons carried in from the localization experiment

See `system1-localization.md`. Context that only *adds* to what the executive would do anyway is pure cost. The continuous loop doubled Astra's input tokens and saved no steps. Wins come from replacing executive actions (polling, re-reading, waiting) or changing decisions. At Luna prices, Jev costs about as much as the executive, so Luna runs are judged on solves, steps and latency, and cost claims need an expensive executive.

## Hypotheses

| # | Hypothesis | Sensors → action | Where tested | Owner / status |
| --- | --- | --- | --- | --- |
| H1 | **The executive stops polling verification.** A tests sensor runs after every edit. System 1 escalates failures and confirms passes, and `run_checks` is answered from the observation of the current revision. | tests → escalate / confirm / serve | Luna dev, `watch*` profiles | Main agent, running (`.ros/evals/luna-watch-v1`) |
| H1a | Delivery timing: async (findings at the next boundary) vs sync (the edit result waits for the observation) | same | same | same |
| H2 | **Intuitive dives.** After a view, System 1 picks which of N next views to follow and auto-follows a few hops. The executive gets the trajectory in one step. | tool results → dive | Luna dev | **Done** (`attention-dives.md`): −1.26 steps (CI −2.19…−0.29), first edit 1.4 steps earlier, half the reads, solves identical over 42 pairs. A lexical rule matches the step gain. System 1's contribution is precision: the executive edited inside 29% of its views vs 4% for the rule, at half the characters, and it lost none of the rule's 2 solves. |
| H3 | **Change integrity.** Static checks and a diff sensor notice broken edits, weakened tests and scope creep. The final gate catches unsupported claims. | lint / compile / diff → escalate, gate | Luna dev | **Done** (`change-integrity.md`): detection works. Offline, System 1's new *warrant* question for self-observations escalates 46/71 harmful test edits vs 1/56 harmless (generic appraisal: 3/71). Luna's outcomes did not change: solves and pooled PASS_TO_PASS breakage are identical across arms (153 trials). Where tampering occurred (flask-5063), 11/11 were caught and 4 recovered (p ≈ 0.045), but none became an official solve. The bottleneck is the executive's response, not perception. |
| H4 | **A world that moves by itself.** Logs, processes and background jobs change independently of the executive. System 1 notices, escalates, and interrupts hung or runaway commands. | logs / processes / blocking call → escalate, interrupt, gate | dynamic-world suite (local, Luna) | **Done** (`dynamic-world.md`): the strongest result. Development tasks: **perception 24/24 vs executive-only 11/24** (p < 0.0001), deliver-all 19/24 (p = 0.05), deliver-none 13/24, rules 21/24 with **6/6 false alarms on distractors vs 0/6**. Hung checks were interrupted after about 15 s instead of waiting out a 90 s timeout. On polling's own tasks: 15/15 at 10.1 steps vs polling's 13/15 at 14.1. Held-out: precision replicated (0 findings on a log full of benign `ERROR`s, rules 3/3 spurious); the solve gap did not (one hazard never fired; one task defeated every arm on its pre-registered grade). |
| H5 | **Metacognitive gate.** Before finishing, System 1 checks the answer against what perception holds, such as a failing observation the executive never saw. | all → gate | covered in H1 and H3 (`followUps: 1`) | — |
| H6 | **Stuck detection.** The executive's own action stream is a sensor. Repeated failing actions and edit/revert cycles get escalated. | tool history → escalate | not yet | open |
| H7 | **Salience filtering of large outputs.** System 1 keeps only the parts of a long log or test output that matter, with a path to the rest. | tool results → transform | not yet | open |
| H8 | **Screens for computer use.** Frames go through a perceptual-hash novelty filter and the same appraisal ("did something change that matters?"), then the same routing. | screen → escalate / dive | design only | open |
| H9 | **System 1 decides when System 2 is needed.** Before every executive model call, System 1 reads the recent trajectory and perception state and answers P(the next step needs deliberation). The strong model takes deliberate steps and the fast model takes routine ones. | executive trajectory → route | Sol-routed dev suite (`evals/suite-sol-dev.json`), then Astra | **Done, negative**: see pilots 1–2 below. |

### H9 mechanism

`agent/agent.ts` uses an Eve `defineDynamic` model with a `step.started` resolver when `ROS_ROUTER=1` (set by the controller when a profile has `router`). The resolver sends a compact trajectory (last 10 messages: text, tool calls, bounded results) to the harness bridge (`agent/lib/route.ts` → `Controller.route`). System 1 answers one independent boolean, `deliberate`, and the controller returns `router.strong` or `router.fast`. Every decision is logged as a `system1/route` event with its probability. Ablations: `random` at a matched strong-step rate, `always-fast`, and the strong model alone (`executive-only` on the strong suite).

Cost logic: Eve warns that prompt caches are per model. A switch back to the strong model re-ingests the steps it has not seen at uncached prices. Uncached ingestion over the run is the same as with the strong model alone, because each token is ingested uncached by the strong model once either way. The saving is the strong model's cached replay and output on routine steps. The risk is quality lost on steps System 1 misroutes to the fast model.

### H9 pilot 1: Luna ↔ Sol (`.ros/evals/sol-router-v1`, 7 tasks × 3 repeats)

| Profile | Solves | Steps | Strong-model steps | Model $ incl. Jev | Mean s |
| --- | --- | --- | --- | --- | --- |
| Sol only (`executive-only`) | 9/21 | 11.67 | 11.67 | $0.038 | 35.0 |
| router-s1 | 9/21 | 12.67 | 5.62 (44%) | ≈$0.033 | 39.7 |
| router-random (rate 0.42) | 9/21 | 10.71 | 3.95 | ≈$0.027 | 38.5 |
| router-fast (Luna only) | 9/21 | 12.95 | 0 | $0.002 | 32.8 |

**Inconclusive by design:** Luna alone solves exactly what Sol solves on this suite, so the best router is "always fast", and no router can show it keeps quality. A deliberation router needs a strong/fast pair with a real quality gap. Astra vs Luna has one: on flask-5063, pytest-5221 and pytest-8365, Astra solved 8/9 attempts and Luna 0/9 (from `astra-dev-v1` and `luna-dev-baseline`). Pilot 2 targets those tasks.

### H9 pilot 2: Luna ↔ Astra on tasks with a quality gap (`.ros/evals/astra-router-v1`, 4 tasks × 2 repeats)

| Profile | Solves | Steps | Astra steps | Model $ incl. Jev | Mean s |
| --- | --- | --- | --- | --- | --- |
| Astra only | 5/8 | 8.38 | 8.38 | $0.141 | 34.2 |
| router-s1 | 3/8 | 10.75 | 4.62 | $0.129 | 42.6 |
| router-random (rate 0.44) | 3/8 | 12.25 | 5.50 | $0.161 | 39.1 |
| router-fast (Luna only) | 2/8 | 10.50 | 0 | $0.0015 | 25.2 |

**Negative.** Halving Astra steps saved 9%, and random routing cost 14% *more* than Astra alone. The earlier cache argument missed two effects. Mixed trajectories are longer (10.8 vs 8.4 steps), because the fast model explores more. And every fast-model step adds context that Astra ingests uncached at its next step. Misrouted design steps also lost solves (3/8 vs 5/8). The one bright spot is the easy control task (pytest-11143: 2/2 at $0.035 vs $0.116). On the tasks where the strong model matters, per-step routing as built loses quality and barely saves money.

Lesson for the architecture: *switching who thinks* mid-trajectory is expensive, both in cache and in coherence. Using System 1 to *reduce what the strong model must do* (perception, dives) kept quality. Routing may still work at turn granularity or with a fast model that only gathers observations without writing to the shared conversation. That's a different design, not tested here.

### Combined perceptual system (`.ros/evals/luna-perceive-v1`, 7 tasks × 6 repeats)

`perceive` = tests sensor (habituation, sync delivery, run_checks served) + grounded alarms + attention dives. `perceive-rules` = the same sensors, with every System 1 decision replaced by a rule (deliver-all, last traceback frame, lexical dive choice).

| Profile | Solves | P2P broken | Steps | First edit | Reads | S1 calls | Mean s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| executive-only | 18/42 | 6/42 | 11.33 | 7.17 | 3.10 | 0 | 32.9 |
| perceive | 15/42 | 5/42 | 9.71 (−14%) | 6.29 | 1.48 | 8.7 | 38.3 |
| perceive-rules | 18/42 | 6/42 | 9.90 (−13%) | 6.38 | 1.55 | 0 | 31.6 |

The step savings stack. All three lost solves are on **pytest-7490**, and the cause is a finding in its own right.

**Premature commitment.** The 7490 fix belongs in the report hook, which runs after the test call. In the failed `perceive` attempts Luna patched the pre-call hook (2) or over-restricted the condition (1), after 6–8 steps instead of 8–14. The visible check passes either way, so perception had nothing to object to. Across every Luna run so far, executive-only solved 7490 in **29/30** attempts and perception arms in **61/69**. The 8 failures are spread over localize, deliver-all, lexical dives and `perceive`. Whatever lets the executive commit sooner sometimes lets it commit to a plausible wrong fix. A perceptual system that accelerates deliberation can make it hasty.

Implication: perception reports what was observed. Nothing yet asks whether the observations *cover the claim*: a passing check means "not falsified", not "verified". Next mechanism: a metacognitive **evidence-coverage gate**. Before finishing, System 1 asks whether any observed check exercises the reported behavior, and if not, asks the executive to show it.

### Evidence-coverage gate (`.ros/evals/luna-gate-v2`, 7 tasks × 6 repeats)

`src/monitors/coverage.ts`. At the final answer, System 1 answers P(the observed evidence exercises the behavior the task reports) over the task, diff and latest check. Below 0.5 the executive is asked once to demonstrate the reported scenario.

| Profile | Solves | P2P broken | Challenges | Steps | Mean s |
| --- | --- | --- | --- | --- | --- |
| executive-only | 18/42 | 5 | — | 11.43 | 34.3 |
| perceive | 17/42 | 6 | — | 10.64 | 38.8 |
| perceive-gate (System 1) | 18/42 | 8 | 33/42 | 13.98 | 55.7 |
| perceive-gate-always | 18/42 | 8 | 42/42 | 13.52 | 58.3 |

**Negative as built.** The gate wins back the premature-commitment loss (pytest-7490 5/6 → 6/6). But System 1 challenged 79% of answers, barely more selective than "always", and each challenge costs about 3–4 steps and 17 s. "Was the claim tested?" is too hard a judgment to make well from a diff and a check log. The cheaper fix for haste is not to rush the executive in the first place: deliver only high-confidence anticipations (next section).

### Anticipation: next-action prediction (`next-action-prediction.md`)

System 1 predicts the executive's next view after every read or search and opens it speculatively when confident. Offline over 346 held-out views, Jev's top guess is about 2× as accurate as a lexical rule. At P ≥ 0.8 the predicted view is used within 3 actions 94% (Luna) and 80% (Astra, never tuned on) of the time. Live on Luna: at P ≥ 0.5, **−15% steps and −21% executive input tokens (both CIs exclude 0)**, while the lexical rule gets −14% steps with +2% tokens. At P ≥ 0.8, half of the delivered views are where the executive later edits, with no accuracy cost.

### Stacking on GPT-6.1 Sol (`.ros/evals/sol61-stack-v2`, 7 tasks × 6 repeats)

| Profile | Solves | Δ steps (task CI) | Δ cost incl. Jev (task CI) | Δ wall time (task CI) |
| --- | --- | --- | --- | --- |
| executive-only | 28/42 | — | — ($0.0273) | — |
| watch2-sync | 28/42 | −0.9% (−11…+7) | +3.6% (−2…+10) | **+21% (+14…+28)** |
| anticipate (P ≥ 0.8) | 28/42 | −2.8% (−8…+4) | −0.5% (−8…+6) | +7% (+3…+12) |
| stack (both) | 31/42 | −4.6% (−10…+0.5) | +1.0% (−12…+14) | **+34% (+19…+53)** |

**No savings on a strong executive, and the gains do not stack into savings.** The tests watcher makes every edit wait on a real test run. Sol 6.1 verifies little and explores efficiently, so there are few executive steps left to replace.

The one consistent signal is **pytest-5221**, where finding the code that prints `--fixtures` output is the hard part. Arms that deliver confident anticipated views solved it 14/18 across the two Sol 6.1 runs, vs 3/12 for executive-only (Fisher p = 0.008). That is one task, so it is a lead for a larger benchmark, not a finding.

### Cross-cutting conclusion (2026-10-01)

System 1's gains concentrate where System 2 cannot attend. On Luna, perception, anticipation and verification shortcuts all helped, because a weak executive wastes steps and misses signals. On GPT-6.1 Sol most of that vanishes: the strong executive watches logs itself, explores efficiently and verifies sparingly. What remains is (1) the **interrupt reflex**: while the executive is blocked in a tool call it perceives nothing, and System 1 cut hung-check time 54% with zero false interrupts; (2) **precision**: zero false alarms where rules raise them every time; (3) a possible localization effect on hard-to-find edits (pytest-5221). The claim that survives is narrower and sharper: *an always-on System 1 is valuable during the executive's blind periods*, not as a general accelerator.

## Method

1. Iterate on Luna (`evals/suite-luna-dev.json`: 7 dev tasks, 3 repeats, interleaved, paired within one run, always with `executive-only` and at least one ablation arm).
2. Summarize with `evals/pairs.py`. Read `events.jsonl` to see what the executive saw and did. Look for System 1 `appraisal`, `escalation` and `finding` events.
3. Only a hypothesis that holds on Luna goes to Astra, for cost and latency confirmation. Then one run on `evals/suite-astra-validation.json` (held-out tasks), with no further changes.
4. Record every run, including negative results, in the relevant experiment doc.

## Results

### H1: the executive stops polling verification (Luna dev, 7 tasks × 3 repeats, paired and interleaved)

**v1** (`.ros/evals/luna-watch-v1`, commit `d44eae8`): tests sensor on edit, plus a process sensor every 3 s.

| Profile | Solves | Steps | `run_checks` | Findings delivered | S1 appraisals | Mean s |
| --- | --- | --- | --- | --- | --- | --- |
| executive-only | 8/21 | 11.57 | 1.43 | — | — | 31.4 |
| watch (async delivery) | 9/21 | 12.48 | 1.52 (all served) | 1.0 | 1.9 + 8.9 process | 33.6 |
| watch-sync (edit waits for the observation) | 9/21 | 10.43 | 1.05 (all served) | 2.5 | 1.9 + 10.9 process | 48.1 |
| watch-sync-all (no judgment) | 8/21 | 10.71 | 0.90 | 11.4 | 0 | 35.8 |
| watch-sync-none (silent sensors) | 9/21 | 11.14 | 1.52 | 0 | 0 | 40.2 |

What v1 showed:
- Delivery timing matters. With async delivery the result shows up at the next boundary, which is usually the executive's own `run_checks`, so nothing is replaced. With sync delivery, the observation arrives with the edit and the executive verifies less.
- The process sensor is noise on SWE-bench. It made about 10 appraisals per attempt, all routine. `deliver-all` pushed 11 findings per attempt, and System 1 cut that to 1–2, but there was little signal to find.
- The Flask suite has pre-existing failures, and with no reference state every observation looked like a failure. This motivated **habituation**.

**v2** (`.ros/evals/luna-watch-v2`, commit `f66aa1b`): adds a baseline observation at start (`on: ["start", "edit"]`), tells the appraisal which observation is the baseline, normalizes novelty (durations, addresses, temp paths), and drops the process sensor.

| Profile | Solves | Steps / attempt | `run_checks` | Findings | S1 calls | Mean s | Model $ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| executive-only | 9/21 | 11.76 | 1.67 | — | 0 | 34.0 | $0.0021 |
| **watch2-sync (System 1)** | **9/21** | **10.00** | 0.95 | 1.29 | 2.2 | 33.8 | $0.0021 |
| watch2-sync-all | 8/21 | 10.48 | 1.14 | 2.10 | 0 | 45.2 | unknown (one 240 s timeout) |
| watch2-sync-none | 9/21 | 12.14 | 1.62 | 0 | 0 | 40.3 | $0.0020 |

Task-level paired effects vs executive-only (bootstrap over 7 tasks):
- watch2-sync: **−1.76 steps per attempt (95% CI −2.67…−0.76), fewer on 5/7 tasks.** Time changed by −0.2 s (CI −6.7…+5.7). Solves unchanged. With Luna the saved steps pay for Jev's calls exactly.
- deliver-all: −1.29 steps (CI −2.48…0.00), +11 s time.
- deliver-none: +0.38 steps (CI −0.86…+1.62).
- System 1 vs deliver-all: −0.48 steps (CI −1.48…+0.43). The decision model's measured contribution so far is precision (fewer, relevant findings; no runaway trial), not yet a separable step effect.

Interpretation: a modest, real effect with a general mechanism. Perception takes over a routine verification loop, and the executive stops polling. On SWE-bench the world changes only when the executive edits and the executive already verifies, so this is the floor of what always-on perception can do. H4 (a world that changes by itself) tests the ceiling.

**v3** (`.ros/evals/luna-watch-v3`, commit after `f617073`): grounded alarms (`src/grounding.ts`). Failure findings carry the output tail plus up to two workspace locations from the traceback. System 1 selects them with independent P(look here) questions, or the last frames in the ablation. They are read through the confined reader so the executive can edit them directly.

| Profile | Solves | Steps | Reads + searches | Grounded dives | S1 calls | Mean s | Δ steps vs exec-only (CI) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| executive-only | 9/21 | 12.00 | 6.19 | — | 0 | 31.0 | — |
| watch2-sync (replicate of v2) | 9/21 | 11.52 | 6.05 | — | 2.7 | 37.1 | −0.48 (−2.10…+1.00) |
| watch3-ground (System 1) | 9/21 | 11.14 | 5.33 | 0.90 | 3.5 | 35.6 | −0.86 (−1.90…+0.24) |
| watch3-ground-lastframe | 9/21 | 11.19 | 5.67 | 0.52 | 2.2 | 36.2 | −0.81 (−1.95…+0.48) |

**The v2 effect did not fully replicate.** Pooling v2 and v3 for watch2-sync vs executive-only (42 attempts per arm): **−1.12 steps per attempt (−9.5%, CI −2.02…−0.40), fewer on 5/7 tasks, solves unchanged, time +3 s (CI −2…+7).** Per-attempt step SD is about 2.8, so single 21-attempt runs cannot resolve effects under about 1.5 steps. Pool runs or add repeats before claiming anything smaller.

Grounding reduces exploration (reads + searches 5.3 vs 6.2) but does not yet separate from the last-frame rule. System 1 grounds more often (0.9 vs 0.5 dives), and neither changes solves.

**H1 verdict so far:** always-on verification perception gives a modest, replicated reduction in executive steps, about 1 per attempt, with no accuracy cost. On Luna it saves no latency, because edits wait on real test runs and Luna's steps are cheap and fast. The mechanism should pay more with an expensive, slow executive, where each avoided step costs about $0.015 and 3 s on Astra. That's the Astra confirmation to run once the other hypotheses report.
