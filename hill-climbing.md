# Hill-climbing ROS Harness

We are tuning the actual coding harness to solve SWE-bench issues with fewer expensive executive calls. Modal runs the ROS controller, its local tool bridge, and the authored Eve agent. These experiments use live inference; the deterministic replay fixture is only a local smoke check.

The constructor inspects grades, traces, and costs, changes a policy or harness behavior, then runs paired trials again. Constructor edits are explicit source/configuration changes. The runner evaluates candidates and records selection; runs are finite and bounded.

## Architecture

| Component | Responsibility | Files |
| --- | --- | --- |
| System 1, Jev | Choose `wait`, `read_related_file`, or `escalate`, with native probabilities | `src/system1.ts` |
| Controller | Schedule perception, enforce confidence and budgets, read files, reject stale results, deliver evidence | `src/controller.ts`, `src/tuning.ts` |
| Executive, Luna or Astra | Diagnose the issue, decide edits, run checks, report results through Eve | `src/executive.ts`, `agent/` |
| Workspace and bridge | Confine access, enforce read-before-edit and version checks, expose tools | `src/workspace.ts`, `src/bridge.ts` |
| Evaluation runner | Freeze source/configuration, create sandboxes, collect telemetry, grade patches, compare candidates | `evals/modal_runner.py`, `evals/run-task.ts` |

Jev sees the issue, a bounded set of unread candidate paths, the latest tool result, source excerpts, delivered paths, and the remaining reflex budget. It selects an action and file. Ordinary controller code performs an allowed read and places actual source excerpts on the perception board. File ranking, excerpt selection, deduplication, and version checks are ordinary code too.

The controller primes the board before the executive's first model call. It evaluates after tool results and on a bounded timer while the executive runs. Focused policies skip unchanged snapshots; high-confidence reads can chain within a fixed budget. The executive receives new observations once, with line numbers, while earlier evidence remains in its conversation.

System 1 remains read-only. The executive is the only writer and runner of the configured check command. Decisions and observed context are displayed as such; generated text must not be presented as hidden reasoning.

## Changes already made

- Expanded the confined inventory beyond the original first 100 files and ranked bounded candidate sets against task/tool evidence.
- Supplied initial perception in the executive's actual prompt instead of relying only on client-context metadata.
- Replaced repeated whole-board delivery with incremental, bounded excerpts. Long excerpts center on issue locations or matching code, and the board budget is split across files.
- Added literal search, ranged reads, and exact single-match replacement, retaining read/version safeguards.
- Added rates, thresholds, context sizes, reflex chains, frame/read budgets, unchanged-state suppression, and a classifier failure circuit breaker.
- Recorded both lanes' reported costs, tokens, calls, latency, and observed effects. Missing costs and incomplete inference requests are unknown, never free.
- Added fresh coding/grading sandboxes, exact base-commit reset, gold-patch calibration, pinned dependencies, immutable experiment directories, and paired selection checks.
- Made models configurable and added per-lane cost/cache tables and alternating trial order with `--interleave`.

The main profiles are `executive-only`, `focused-budgeted`, and `relevance`. Earlier `baseline` and `focused` profiles remain available. `relevance` asks native boolean questions about whether each file supplies needed evidence; those probabilities differ from categorical target probabilities and need separate evaluation.

## Measured Luna results

On `pytest-dev__pytest-11143`, both policies passed official grading in all three repeats. Both used Luna with `low` reasoning and the same frozen source/configuration. Profiles ran in groups. Task time excludes provisioning and runtime boot.

| Policy | Solves | Median task time | Mean executive cost | Mean Jev cost | Mean total model cost |
| --- | --- | --- | --- | --- | --- |
| Executive only | 3/3 | 40.37 s | $0.001856 | $0 | $0.001856 |
| Focused System 1 | 3/3 | 26.86 s | $0.001208 | $0.001722 | $0.002930 |

Focused perception reduced median task time by 33.5%, but raised model spend by 58%. It saved approximately $0.00065 of executive inference while adding $0.00172 of Jev inference. Luna's cached-input share was about 91% without System 1 and 94% with it. These traces do not show a Luna cache regression.

System 1 averaged 9.3 evaluations and one file prefetch per attempt. The executive averaged 10.7 calls without System 1 and 7.3 with it. Many perception evaluations produce little additional evidence while the executive baseline is already cheap and heavily cached. Jev cache-hit counters are not currently collected.

The full three-task development suite produced 1/3 solves for each tested policy. Both Flask development issues failed official grading. Focused System 1 solved 0/2 held-out tasks; both gold patches passed calibration. One held-out trial also returned an invalid categorical target distribution. Broader reliability and cost gains remain unconfirmed.

Local evidence, kept out of Git:

- `.ros/evals/20260930T203123/`: executive-only and boolean-relevance repetitions.
- `.ros/evals/20260930T203652/`: focused-policy repetitions.
- `.ros/evals/20260930T202346/`: full development suite.
- `.ros/evals/20260930T204247/`: focused held-out validation.
- `.ros/evals/constructor-report.md`: constructor notes.

## Astra comparison

The experiment uses `openai/gpt-6-astra` with `low` reasoning, comparing executive-only against the same focused Jev policy on the same pytest issue. It has three repeats per policy, with alternating policy order. The hypothesis is that avoided Astra work can outweigh Jev's additional bill. A more expensive executive alone does not guarantee savings: it may need fewer calls even without perception, and prefetched context also costs tokens to process.

Astra supports `low` reasoning according to the [official model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra). The Gateway catalog and live calls verified `openai/gpt-6-astra`.

All six attempts passed official grading, with complete cost coverage and no System 1 errors. The immutable output directory is `.ros/evals/20260930T212913/`; its harness source hash is `cd15868cf31644e23e4b5169bb5ced47f2eff0cc133de5505686c4a8d1015e44`.

| Policy | Solves | Median task time | Mean executive cost | Mean Jev cost | Mean total model cost |
| --- | --- | --- | --- | --- | --- |
| Astra only | 3/3 | 35.51 s | $0.115220 | $0 | $0.115220 |
| Astra + focused System 1 | 3/3 | 37.91 s | $0.184216 | $0.002575 | $0.186790 |

System 1 raised model spend by 62.1% and median task time by 6.8%. Jev was only 1.4% of the enabled bill, so its direct overhead was small as hypothesized. The larger expense came from Astra processing more context without avoiding executive calls. Both policies averaged 7.7 executive calls; focused perception averaged 13.7 Jev evaluations and two prefetches. In every enabled trial, Astra still explicitly read `src/_pytest/assertion/rewrite.py` after the controller had prefetched it. Two trials also reread the prefetched assertion test file.

| Executive usage, mean per attempt | Astra only | Astra + System 1 |
| --- | --- | --- |
| Input tokens across calls | 36,312 | 69,464 |
| Cached input tokens | 31,635 | 62,023 |
| Cache-write tokens | 4,654 | 7,418 |
| Output tokens | 504 | 585 |
| Cached share of input | 87.1% | 89.3% |

The cache-hit share improved while total input grew by 91.3%. These counters point to more newly cached context and more cached context processed across calls, rather than a lower cache-hit share. Both cache writes and reads contribute to billed inference. Output also grew modestly. The runner retained executive-only as the winner and rejected focused perception; total reported model spend for this experiment was $0.906029, excluding Modal estimates and constructor work.

This is a matched policy comparison on one issue with three repeats and low reasoning. It does not establish an Astra-versus-Luna ranking: the Luna runs occurred earlier and used grouped trial order. The next useful hypothesis is to make a prefetch replace an executive retrieval, while reducing context growth; simply choosing a more expensive executive did not make the current policy economical.

## Run an experiment

Use Node 24+, pnpm, uv, an authenticated Modal CLI, and a funded `AI_GATEWAY_API_KEY` in `.env.local`. An existing Modal Secret can be selected with `--secret NAME`. The runner sends only the model key to coding sandboxes. It does not copy local login tokens, `.env` files, `.git`, or runtime state into the image.

```sh
pnpm eval:prepare
pnpm eval:run --calibrate

# Paired Luna policies on the case used above.
pnpm eval:run --profiles executive-only focused-budgeted \
  --instances pytest-dev__pytest-11143 --repeats 3 --interleave

# Astra comparison.
pnpm eval:run --executive-model openai/gpt-6-astra \
  --profiles executive-only focused-budgeted \
  --instances pytest-dev__pytest-11143 --repeats 3 --interleave

# Full development suite, then final held-out validation.
pnpm eval:run --repeats 3 --interleave --holdout

# Compare source changes against a matching baseline.
pnpm eval:run --profiles executive-only focused-budgeted \
  --instances pytest-dev__pytest-11143 --repeats 3 --interleave \
  --compare .ros/evals/BASELINE

# Validate a repeated winner without repeating training.
pnpm eval:run --validate .ros/evals/TRAINING_RUN
```

`--executive-model` changes the sandbox executive and recorded model identity. Interactive defaults stay as configured in `src/models.ts`. `--system1-model` selects an evaluation model, defaulting to `typesafe-ai/jev`. `--compare` requires identical tasks, suite, models, repeats, and dataset fingerprint. A model swap needs its own within-model control. `--validate` uses the training winner's exact source, model settings, and tuning; changing source requires retraining.

`evals/suite.json` sets tasks, visible checks, reasoning, and budgets. Current bounds are 240 task seconds, 24 executive steps, and $1 executive spend per attempt; budgets checked after calls can overshoot by one call. Grading has its own timeout. Jev is separately bounded by frames, input size, and reflex reads. The executive cap excludes Jev, sandbox costs, and other attempts in the experiment.

## Evaluation and selection

Each attempt starts in a fresh SWE-bench image reset to the exact base commit. The coding process receives the issue and visible check command, then observes workspace evidence through the harness. Gold patches, grading tests, and pass/fail labels stay out of its context.

A second fresh sandbox receives the model diff and official evaluation script. Official `FAIL_TO_PASS` and `PASS_TO_PASS` results determine resolution. A success claim, a passing visible check, or altered local test expectations does not establish a solve. Gold-patch calibration runs only in isolated graders and catches broken environments before model spending.

The score is mean solved-task time, with a 900-second penalty per failure, plus 30 seconds per dollar of model spend across both lanes and all attempts. Candidates must preserve every incumbent solve, then solve more tasks or improve the time/cost component by at least 5%. Equal failure penalties are removed when computing that percentage. Unpaired/incomplete trials, System 1 errors, and incomplete cost coverage block promotion. No solves means no winner. Three repeats are a minimum confirmation, not statistical certainty. A speed-selected winner can still cost more; the objective's cost weight is configurable.

Sandbox resource costs are separate estimates from requested CPU/memory and wall time. Build time, egress, credits, and actual billed utilization are not metered. Provider-reported model cost is the spend evidence; cache counters are diagnostic.

Inspect `manifest.json`, `report.md`, `summary.json`, `results.json`, and `winner.json` under `.ros/evals/RUN/`. Attempts have metrics, events, a submitted patch, runtime logs, and grading output when a patch was graded. Jev-enabled trials also have `snapshots.jsonl`, the actual classifier inputs. The manifest records source/runner hashes, model settings, row hashes, image/base commits, profiles, budgets, and trial order. `source/` and `runner.py` preserve what ran. Result directories are never overwritten.

## Swarming on improvements

Start collaborators from the same source/configuration baseline. Give each a hypothesis and file ownership, and use separate branches/worktrees for concurrent edits. Create uniquely named profiles and output directories. One constructor should coordinate merges and rerun combined changes, since independently useful changes can interact.

Useful experiments:

1. **Reduce low-value Jev calls.** Test event eligibility, stopping after useful context arrives, and ordinary-code handling of unambiguous check outcomes. Measure useful reflexes per evaluation and total spend.
2. **Improve prefetched excerpts.** Deliver smaller, more useful source neighborhoods and relevant tests so the executive does not immediately reread the same file. Measure avoided calls and newly processed context.
3. **Improve decision reliability.** Investigate categorical target responses that fail SDK validation. Compare boolean relevance or narrower questions while preserving native probabilities and explicit error accounting. Do not invent confidence or silently reinterpret invalid distributions.
4. **Preserve public behavior.** Improve executive instructions and tool ergonomics. Inspect official regression failures, redundant searches, unnecessary narration, and weakened test assertions.
5. **Test model economics.** Use matched controls at each executive model/reasoning setting. Compare total dollars per official solve, latency, cache usage, and Jev's marginal cost.

For each proposal, bring its hypothesis, source/configuration hashes, command, official grades, at least three paired repeats, per-lane costs, and trace evidence explaining the gain. Tune on development tasks. The existing held-out set has already been inspected; reserve fresh tasks for stronger future validation. Keep task-specific answers out of generic prompts and grading artifacts out of coding-agent context.

After runtime changes, run `pnpm typecheck`, `pnpm test`, and `pnpm demo --plain`. Read installed AI SDK documentation before changing its experimental evaluation API. Read Eve's bundled documentation before editing authored definitions, then run `pnpm exec eve info --json`. Run `pnpm eval:test` after runner/selection changes. Keep credentials, traces, and runtime state out of Git; this document records aggregates only.
