# Hill-climbing the real harness

The coding sandbox runs `src/controller.ts`, `src/system1.ts`, the local tool bridge, and the authored Eve executive. The configured executive (GPT-6 Luna by default) performs edits and checks; Jev performs read-only perception. This is live inference, never the replay demo. See [hill-climbing.md](../hill-climbing.md) for measured Luna/Astra results and contributor experiments.

Requires Node 24+, pnpm, uv, an authenticated Modal CLI, and a funded `AI_GATEWAY_API_KEY` in `.env.local` (or `--secret NAME`). The runner passes only that key as an ephemeral Modal Secret. It does not copy local login tokens, `.env` files, or `.git`.

```sh
pnpm eval:prepare                         # boot and typecheck one real task image
pnpm eval:run --calibrate                 # verify official gold patches in graders
pnpm eval:run                             # 3 tasks × 3 policies, one trial each
pnpm eval:run --repeats 3 --holdout        # repeated selection, then unseen tasks
pnpm eval:run --validate .ros/evals/RUN    # validate a repeated winner without retraining
pnpm eval:run --executive-model openai/gpt-6-astra --instances pytest-dev__pytest-11143 --profiles executive-only focused-budgeted --repeats 3 --interleave
pnpm eval:run --instances pallets__flask-4045 --profiles baseline focused
pnpm eval:test
```

`suite.json` fixes development tasks, held-out tasks, developer-visible check commands, wall time, steps, reasoning effort, and the executive model budget. `profiles/*.json` controls System 1 instructions, confidence threshold, sampling rate, unchanged-state suppression, context sizes, reflex budget, and bounded chains of read-only reflexes. The default comparison starts with `executive-only`, then tests `focused-budgeted` and `relevance`. `baseline` and `focused` retain earlier policies for comparison. Add a named profile and pass it to `--profiles` to test a candidate. Jev must supply action and target probabilities before a reflex can execute; confidence is not invented when the provider omits a distribution. `relevance` uses native boolean P(file supplies needed evidence) instead of a categorical target distribution; its threshold has different semantics and needs evaluation.

`--executive-model` and `--system1-model` override the evaluation models and record their identities in the manifest. `--interleave` alternates profile order across repeats to reduce timing and cache-warmup bias. Comparisons require matching models; validation restores the training winner's models. Interactive defaults remain configured in `src/models.ts`.

The harness supplies initial observations before the executive's first model call. It delivers later observations once, centers long source excerpts on issue locations or matching code with exact line numbers, and splits the board budget across files. It skips unchanged inference, caps frames and reads, and offers bounded literal search and exact replacement tools. The executive remains the only writer and check runner.

Each attempt starts from a fresh SWE-bench image reset to its exact base commit. The model receives only the issue statement and configured visible test command. A second fresh sandbox receives the submitted diff and official evaluation script; gold patches, grading tests, and test labels do not enter the coding agent's context. Both sandboxes terminate in `finally` blocks. Calibration exercises gold patches only inside isolated graders so broken environments can be identified before tuning.

The [official SWE-bench grader](https://www.swebench.com/SWE-bench/api/harness/) checks `FAIL_TO_PASS` and `PASS_TO_PASS`. An executive claim or passing visible check does not score a solve. Dataset/image references and SHA-256 hashes of exact dataset rows and authored source are saved in the manifest. Dependencies are pinned in `uv.lock` and `pnpm-lock.yaml`.

Results stay in Git-ignored `.ros/evals/<run>/`:

- `report.md`, `summary.json`, `results.json`: solve rate, time, executive steps, System 1 calls/reflexes, tokens, reported model costs, sandbox timing, and resource cost estimates.
- `winner.json`: accepted profile and source hash. One-repeat results are explicitly provisional.
- Per attempt: `metrics.json`, `events.jsonl`, `snapshots.jsonl` (actual bounded System 1 inputs), `model.patch`, `harness.log`, `eve.log`, `grade.json`, `test_output.txt`.
- `holdout.json`: final validation; never used to select a profile.
- `source/`, `runner.py`, `manifest.json`: exact allowlisted harness source, evaluation runner, configuration and hashes used in the experiment.

The objective is mean solve time with a 900-second failure penalty, plus 30 seconds per dollar of reported model spend, including failed attempts and both lanes. A candidate must preserve every incumbent solve, then solve more tasks or improve the time/cost component by at least 5%. Equal failure penalties are subtracted only when calculating that percentage, so unsolved tasks cannot hide savings on solved tasks. Unpaired tasks, incomplete runs, System 1 errors, and incomplete cost coverage block promotion. A run with no solves produces no winner. `--compare` also requires an improvement over the prior winner before promoting new code. Modal costs are separately labeled estimates based on requested resources and wall time, using dated [Sandbox pricing](https://modal.com/pricing); build time, egress, credits, and actual utilization are not metered here. Model budgets are checked after calls and can overshoot by one call.

## Constructor workflow

1. Calibrate the fixed suite, then run a baseline with the intended repeat count.
2. Inspect failed grades and actual tool/decision traces. Look for irrelevant reads, withheld useful reads, repeated observations, token growth, unnecessary executive steps, and check latency.
3. Change one hypothesis at a time: `profiles/`, typed questions in `src/system1.ts`, scheduling/board integration in `src/controller.ts`, or executive instructions/tools in `agent/`.
4. Run `pnpm typecheck`, `pnpm test`, `pnpm demo --plain`, and `pnpm exec eve info --json` when changing authored tools. Keep System 1 read-only and never put task-specific answers into prompts.
5. Rerun identical tasks/repeats. `--compare .ros/evals/<baseline>` verifies matching suite and dataset and records paired comparisons across source snapshots. Keep immutable old runs for review.
6. Confirm promising policies with at least three repeats, then use `--holdout` once for the final candidate. Update defaults only after confirmation. Optimizing these few public issues establishes a local experiment, not a general SWE-bench result.

Apply an accepted policy with `pnpm start --tuning evals/profiles/focused.json --workspace ... --task ...`. The runner is finite and bounded; run another iteration after inspecting the previous results.

## Dynamic-world suite (local, no Modal)

`evals/dynamic/` measures always-on perception where the environment changes independently of the executive: background services and workers that react to edits, dead-letter queues, and the executive's own checks hanging. Tasks are template repositories under `evals/dynamic/tasks/<id>/` with hidden graders; the design, fairness argument and results are in [docs/experiments/dynamic-world.md](../docs/experiments/dynamic-world.md).

```sh
pnpm exec tsx evals/dynamic/run.ts --calibrate                                   # graders and world dynamics, no models
pnpm exec tsx evals/dynamic/run.ts --scripted naive --arms perception,rules     # scripted executive (no model), live Jev
pnpm exec tsx evals/dynamic/run.ts --repeats 3 --concurrency 4 --budget 5       # live Luna executive, all arms
pnpm exec tsx evals/dynamic/run.ts --report .ros/evals/dynamic-<name>           # rebuild report.md
```

Each attempt runs `evals/run-task.ts` with a private Eve project root (Eve keeps per-project workflow state in `.eve/`), starts the task's services, and grades the workspace after they stop. Traces go to `.ros/evals/dynamic-<name>/<task>/<arm>/r<k>/` (`events.jsonl`, `metrics.json`, `grade.json`, `result.json`, `world/` logs and queues). Scripted runs are labeled `scripted` and never count as executive results. Do not run bare `node --test` at the repository root: task templates contain deliberately hanging tests.
