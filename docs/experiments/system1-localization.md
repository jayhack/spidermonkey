# Experiment: System 1 as pre-attentive localization

Status: **recorded, not pursued** (2026-09-30). Localization is a pre-first-call context pump, not ongoing perception. The project chose to study always-on monitoring instead (`docs/experiments/perception-study.md`), and every monitoring profile excludes `localize`. The code stays in `src/localize.ts` for reference. The held-out validation run was not performed, so the result is not promoted.

## Question

Can a cheap System 1 (Jev) make an expensive executive (`openai/gpt-6-astra`, low reasoning) cheaper or faster on SWE-bench issues without losing official solves?

## Why the earlier integration lost

The continuous perception loop (`focused-budgeted`) ran Jev about 14 times per attempt and made about 2 file reads. With Astra it **doubled executive input tokens** (208k vs 109k over three attempts), used the **same number of executive steps** (23 vs 23), and raised model spend 62% ($0.187 vs $0.115 per solve; `.ros/evals/20260930T212913/`). The trace shows why:

1. Prefetched excerpts landed in the executive's context, and then the executive ran its own `search` → `read_file` anyway. Every prefetched token was extra.
2. Astra pays about $12.5/M for uncached input, about $1/M for cached replay, and about $50/M for output (derived from per-step `costUsd`). Jev costs about $0.04/M input. Unused context is the expensive failure mode, and Jev calls themselves are nearly free.
3. Timer frames in a filesystem-only workspace see nothing new, so they return `wait` or low-probability `held` decisions.

So System 1 only pays off if it **replaces executive steps**, not if it adds context next to them.

## Mechanism: localize before the first call

`src/localize.ts`, enabled by `evals/profiles/localize.json` (`continuous: false`, `localize: {...}`):

1. **Ordinary code** chunks every source file into definition-level spans (functions, methods, classes; long bodies become 80-line windows) and ranks them with BM25 against the issue text. Code-like tokens, traceback `file:line` locations, and definition names get extra weight. Files are ranked by their best chunks.
2. **Jev file stage** (one `evaluate` call): an independent boolean for each of the top 24 source files ("must this file be edited?") and each of the top 8 test modules ("does a regression test belong here?"). State is the issue plus each file's definition outline. Test modules named after, or importing, a likely source module get a lexical bonus.
3. **Jev chunk stage** (one call): an independent boolean for up to 24 chunks in each of the top two source files, and 16 chunks in the top test module, with 40-line previews.
4. **Controller delivery**: chunks with P ≥ 0.5 (the best one needs only P ≥ 0.2), up to 4 chunks and 6,000 characters, plus at most one test chunk with P ≥ 0.4 (2,000 characters). They are re-read through the confined reader, checked against current content, and written into the executive's first prompt as plain text with exact line ranges. That read **authorizes `replace_text`** on those files, so the executive can edit on its first call. Files System 1 only ranked (via `Workspace.peek`) are not authorized for edits.
5. No timer frames, no post-tool reflexes, and no perception board on tool results (`continuous: false`). The board was billed on every step even when empty.

System 1 stays read-only. Everything delivered is observed file content with a native probability label. Nothing is generated text presented as reasoning.

## Offline localization benchmark

End-to-end Modal trials are slow and noisy, so the localizer was tuned offline first:

```sh
uv run --project evals python evals/prepare_localization.py --repos /path/outside/git   # 71 SWE-bench Lite instances, 11 repos
npx tsx evals/localize-bench.ts --mode jev --split tune --options '{"testFiles":8}'
npx tsx evals/localize-bench.ts --mode jev --split test --options '{"testFiles":8}'
```

The instances exclude every end-to-end dev and held-out task. The localizer sees only the issue and the checkout. Gold hunks are read only by the scorer after selection. It was tuned on `tune` (26 instances) and reported on `test` (45 instances, never tuned on).

| Localizer (test split, n=45) | Gold hunk delivered | Right file ranked first | Chars delivered | Cost / issue | Latency |
| --- | --- | --- | --- | --- | --- |
| Lexical BM25 only, top 4 chunks | 42% | 42% | 4,518 | $0 | 0.8 s |
| First attempt: Jev over lexical top 32 chunks (tune split) | 31% | — | 1,846 | $0.0006 | 1.3 s |
| **Two-stage Jev (files → chunks)** | **60%** | **67%** | **2,764** | **$0.0015** | **1.6 s** |

Correct test module delivered: 53% of test-split issues. A test chunk within 40 lines of the gold test hunk: 29%.

Lessons:

- A single chunk-stage call was limited by lexical candidate recall (35%). Jev ranked well *when the gold chunk was among the candidates* (top-1 in 8 of 9 cases), so the fix was a file stage that widens recall before chunk scoring.
- Jev answers vary a little between identical runs (file top-1 moved ±4 points). Report means over splits, not single runs.

## End-to-end results (Modal, official SWE-bench grading)

Dev suite: `evals/suite-astra-dev.json` (3 original dev tasks plus 4 pytest tasks from the localization tune split). Paired, interleaved, 3 repeats, `--parallel 6`. Run: `.ros/evals/astra-dev-v1/`.

| Astra (`gpt-6-astra`, low) | Solves | Executive steps / attempt | Model $ / attempt (both lanes) | Mean task s | First edit at step |
| --- | --- | --- | --- | --- | --- |
| executive-only | 17/21 | 8.19 | $0.142 | 35.0 | ~5.0 |
| localize | 16/21 | 6.05 (−26%) | $0.127 (−10%) | 29.8 (−15%) | ~2.6 |

Task-level effects (7 tasks): steps fell on 7/7 (mean −2.1, 95% task-bootstrap CI −2.9…−1.6). Cost fell on 6/7 (mean −10%, CI −19%…−2%). Time fell on 6/7 (mean −12%, CI −25%…+4%). The selection rule rejected `localize` because pytest-8365 went 2/3 → 1/3. In both arms Astra chose between two fix designs: sanitizing the username fails the hidden test, falling back to `pytest-of-unknown` passes. That split looks like sampling (Fisher p = 1.0), but under the rule the result stands.

The cost cut is smaller than the step cut because the first call carries about 2.0k more uncached tokens ($0.036 vs $0.010 for the first call). Executive-only first calls also got about 1.2k cross-session cached tokens, which localize first calls never got. The cause wasn't confirmed; per-turn `clientContext` is a suspect.

| Luna (`gpt-6-luna`, low), run `.ros/evals/luna-dev-baseline/` | Solves | Steps | Model $ / attempt | Mean task s |
| --- | --- | --- | --- | --- |
| executive-only | 9/21 | 11.10 | $0.0021 | 34.5 |
| localize | 8/21 | 8.24 | $0.0032 | 30.7 |

With a cheap executive, Jev's ~$0.0014 per attempt exceeds what it saves, so System 1 cost wins require an expensive executive. Luna is suited to solve, step and latency comparisons only.

## Conclusion

Pre-first-call localization reliably moves the first edit earlier and removes about two executive steps per issue on repos up to about 2.5k Python files. The prediction is *where to look*, and Jev makes it better than lexical ranking at 60% of the characters. It does not change what the executive decides, and it is a one-shot context pump, not continuous perception. Open issues: validation on held-out tasks, the first-call cache miss, and scaling (persistent index, coarser first stage) for monorepos.
