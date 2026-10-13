# Experiment: intuitive dives (automatic attention shifts during navigation)

Status: complete (2026-09-30). Two paired Modal runs on the Luna dev suite, 126 trials: `.ros/evals/dives-v1/` and `.ros/evals/dives-v2/`.

**Summary.** Dives reliably replace executive navigation. Pooled over 42 paired attempts, `read_file` calls fall by half, the first edit arrives 1.4 steps earlier, and executive steps fall by 1.3, with identical official solves in every pair. The step savings are **not** attributable to the decision model: a trivial rule that always follows the top lexical candidate saves as many steps. What Jev adds is **attention precision**. The executive edits inside 25-29% of the views Jev delivers, versus 4-7% for the lexical rule. Jev delivers half the characters or less, and its declines are mostly correct. The lexical rule lost 2 solves and inflated executive input by up to 31%. On Luna, Jev costs 45-60% of the executive's spend and adds about 2.5 s per attempt, so there is no cost or latency win. A deeper and wider second iteration (v2) did not help.

## Hypothesis

Part of an executive's exploration is predictable. After it reads a range or searches for a name, the next view is usually close by: the definition enclosing a hit, the rest of a function cut off by the read range, the function the viewed code calls, or the test that exercises it. A cheap decision model can make that "where would I look next?" judgment, and the harness can open the views read-only in the same tool call. The executive then gets an attention trajectory for the price of one step.

Prediction: fewer executive exploration steps (`read_file`, `search`) and earlier first edits, with equal or better official solves. The lesson from [pre-first-call localization](system1-localization.md) is built in. Delivered context must **replace** executive steps, not sit beside them, so delivered views count as read and `replace_text` can edit them directly.

## Mechanism

```
executive tool call ──▶ its own result (unchanged)
        │
        ▼
  view (file range or search hits)
        │  affordances (ordinary code): candidate next views
        ▼
  System 1 (Jev, one call per hop): P(follow)  +  independent P(candidate_i)
        │  follow ≥ 0.5 and P ≥ 0.5 → open read-only, bounded characters
        ▼
  repeat from the opened view, ≤ K hops
        │
        ▼
  result + system1Dive: views labeled with path, exact lines, hop, relation, P
```

- **Domain-general engine**, `src/attention.ts`. A `View` is any bounded observation. `Affordances` enumerate candidate next views from views, and each `Candidate` can `open(maxChars)` itself without side effects. A `Chooser` decides whether to follow and which candidates. `dive()` runs at most `hops` hops, `perHop` views per hop, and `maxChars` delivered characters. The Jev chooser asks one boolean `follow` question and one independent boolean per candidate over a shared state: the task, the executive's recent actions, the current views, and the candidates with observed relations and previews. File text is marked as untrusted evidence. The affordance provider supplies the domain criteria text: what is worth following, what is tangential, when the views seen are enough.
- **Code affordances**, `src/monitors/dives.ts`. A definition index (the shared `chunkFile` anchors, plus indentation or brace extents) is built in the background. From **search hits** it proposes the enclosing definition of each hit group, flagged as "definition of `x`" when a hit is the def line. From a **file range** it proposes:
  - the next and previous windows (scrolling), noting when the view cut a definition;
  - definitions of names the view calls, instantiates, or imports (locals and words in comments are not links, test and example definitions are excluded from library views, and ambiguous names with more than 3 definitions are dropped);
  - test functions that reference the viewed definitions.

  Ranges the executive has already seen at the current content hash are never offered. Ordinary code also computes a lexical prior (BM25 against the task plus relation bonuses). The prior orders candidates and drives the lexical ablation.
- **Delivery**. The monitor's `transform` hook appends `system1Dive: { note, views }` to `read_file` and `search` results. Views are plain-text blocks: `--- path lines a-b (definition; hop h; relation; System 1 P=0.83)`. They are opened through `MonitorContext.read`, which authorizes later edits and rejects stale indexes. System 1 remains read-only.
- **Telemetry**. Every dive emits a `dive` event (candidates, priors, probabilities, choice, stop reason, latency). The monitor also emits `dive-used` when the executive later edits inside a delivered view, and `dive-reread` when it re-reads one. `evals/dive_stats.py` summarizes them.

### Why this generalizes

Nothing in the engine knows about code. For a computer-use agent watching screens, the view is a screenshot region or an accessibility subtree. Affordances are ordinary code over the UI: the region below the fold, a link target, the panel behind a disclosure control, the dialog a button opens (read-only: a background tab, a hover preview, a scroll). The same two questions apply: is any of these worth looking at before acting, and which one? The harness returns the whole trajectory with the agent's own screenshot. Only the affordance provider and its criteria sentence change.

## Ablations

| Profile | Candidates | Choice | Executive prompt |
| --- | --- | --- | --- |
| `executive-only` | none | none | unchanged |
| `dives` | code affordances | Jev: P(follow) ≥ 0.5 and P(candidate) ≥ 0.5 | unchanged; the note travels in the tool result |
| `dives-lexical` | the same code affordances | always follow the top lexical-prior candidate | unchanged |

`dives-lexical` isolates Jev's contribution: same candidates, hops, per-hop count, character budget, and delivery format. It lacks only the decision to stop and the choice of which candidate. Every run included all three profiles, interleaved. `mode: "off"` (not run) records candidates without delivering anything.

| Run | Profiles used | Settings |
| --- | --- | --- |
| `dives-v1` (source `d13c1e76…`, commit 5ebc260) | `dives.json`, `dives-lexical.json` | hops 2, perHop 1, 8 candidates, 6,000 chars/call, views ≤ 60 lines |
| `dives-v2` (source `571e06e9…`, commit 0bd4250) | now `dives-deep.json`, `dives-deep-lexical.json` | hops 3, 9,000 chars/call, short definitions padded to ≥ 30 lines |

The committed `dives.json` and `dives-lexical.json` are the v1 settings, which were at least as good as v2 on every metric.

## Commands

```sh
pnpm typecheck && pnpm test && pnpm demo --plain && pnpm exec eve info --json
uv run --project evals python evals/modal_runner.py --suite evals/suite-luna-dev.json \
  --profiles executive-only dives dives-lexical --repeats 3 --interleave --parallel 8 \
  --output .ros/evals/dives-v1        # dives-v2: same command at commit 0bd4250 (profiles then held the deep settings)
uv run --project evals python evals/pairs.py .ros/evals/dives-v1
uv run --project evals python evals/dive_stats.py .ros/evals/dives-v1
cd evals && uv run --project . python paired_stats.py --control executive-only ../.ros/evals/dives-v1 ../.ros/evals/dives-v2
```

Executive `openai/gpt-6-luna` (low reasoning), System 1 `typesafe-ai/jev`, 7 dev tasks × 3 repeats × 3 profiles per run. Official SWE-bench grading. Total reported model spend was $0.30 for 126 trials, plus about $0.87 of estimated sandbox time.

## Results

### Per run

| Run | Profile | Solves | Steps | First edit step | `read_file` | `search` | Exec. input tokens | Median / mean task s | Exec. $ | Jev $ | Jev calls / s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v1 | executive-only | 9/21 | 11.71 | 7.76 | 3.19 | 2.67 | 71,549 | 27.8 / 34.2 | 0.0020 | – | – |
| v1 | **dives** | 9/21 | 10.10 | 5.81 | 1.48 | 2.43 | 62,950 | 29.5 / 32.3 | 0.0019 | 0.0009 | 5.4 / 2.1 |
| v1 | dives-lexical | 8/21 | 9.81 | 5.81 | 1.52 | 2.38 | 67,632 | 27.3 / 29.2 | 0.0020 | – | – |
| v2 | executive-only | 9/21 | 11.48 | 7.14 | 3.00 | 2.52 | 69,650 | 30.2 / 33.2 | 0.0019 | – | – |
| v2 | dives (deep) | 9/21 | 10.57 | 6.33 | 1.57 | 2.57 | 69,732 | 35.0 / 33.4 | 0.0020 | 0.0012 | 6.7 / 2.5 |
| v2 | dives-lexical (deep) | 8/21 | 9.90 | 5.95 | 1.52 | 2.48 | 91,420 | 27.2 / 28.4 | 0.0025 | – | – |

The executive-only arm reproduces the earlier Luna baseline (`luna-dev-baseline`: 9/21, 11.1 steps). Solves are task-determined for this executive. pytest-11143, 7373 and 7490 are solved by every Jev and baseline attempt, and the flask tasks, pytest-8365 and pytest-5221 by none. Both lexical losses are pytest-7490, one per run.

### Paired differences, pooled over both runs (42 pairs of run × task × repeat; bootstrap 95% CI)

| Comparison | Steps | First edit step | `read_file` | Exec. input tokens | Task s | Solves |
| --- | --- | --- | --- | --- | --- | --- |
| dives − executive-only | **−1.26** [−2.19, −0.29] | **−1.38** [−2.05, −0.76] | **−1.57** [−2.02, −1.10] | −4,258 [−14,660, +6,271] | −0.85 [−5.26, +3.39] | 0 (identical in 42/42 pairs) |
| dives-lexical − executive-only | **−1.74** [−2.88, −0.60] | **−1.57** [−2.31, −0.93] | **−1.57** [−2.12, −1.05] | +8,926 [−5,334, +23,149] | **−4.85** [−9.30, −0.58] | −2 |
| dives − dives-lexical | +0.48 [−0.67, +1.60] | +0.19 [−0.50, +0.83] | 0.00 [−0.43, +0.43] | −13,185 [−29,183, +2,385] | +4.00 [−0.38, +8.41] | +2 |

### Attention precision: what the decision model contributes

"Edited inside" means a later executive `replace_text` landed in the delivered view's lines (telemetry `dive-used`). "Touched" means edited inside or later read.

| Run | Profile | Views delivered | Chars / attempt | Edited inside | Touched | Attempts with an edit inside a delivered view | Re-reads |
| --- | --- | --- | --- | --- | --- | --- | --- |
| v1 | dives | 76 | 5,992 | **22 (29%)** | 30 (39%) | **18/21** | 12 |
| v1 | dives-lexical | 136 | 8,810 | 6 (4%) | 13 (10%) | 6/21 | 4 |
| v2 | dives (deep) | 88 | 7,875 | **22 (25%)** | 26 (30%) | **18/21** | 8 |
| v2 | dives-lexical (deep) | 216 | 17,143 | 15 (7%) | 21 (10%) | 14/21 | 7 |

The declines are informative too. When Jev stopped although P(follow) ≥ 0.5, its top candidate (P ≥ 0.35) was later touched by the executive in only 3 of 24 cases (v1) and 5 of 34 (v2). Lowering the threshold would mostly have added unused context.

## What the traces show

- **Dives replace reads, not searches.** The executive keeps searching (about 2.5 per attempt in every arm) but stops following searches with `read_file`. In pytest-7490 (`dives/0`) it searched `evaluate_xfail_marks` and `xfailed_key`. Jev followed the enclosing definition and then the next window of `skipping.py`, and the executive edited line 264 inside the hop-2 view without ever reading the file. In pytest-11143 the first two searches' dives carried the edit location, and the first edit came at step 4 instead of 6-7.
- **Jev picks the view a reader would scroll to; the lexical rule picks the most task-like word.** After a read of `skipping.py` lines 30-180, Jev chose the next 60 lines (P=0.75, containing `evaluate_xfail_marks`) over `outcomes.xfail` (P=0.45), which had the highest lexical prior because the issue says "xfail". The lexical ablation's views were mostly definitions of referenced symbols (67 of 136 in v1). In its failed pytest-7490 attempt it delivered `nodes.py`, `test_mark.py`, `outcomes.xfail` and `pytester` before a wrong edit.
- **Why the lexical rule still saves steps.** With views in hand, Luna edits sooner even when the views are not where it edits. That is the same step saving at up to 2x the characters, which Luna's cheap cached input hides. The v2 lexical arm, taking every third hop, raised executive input by 31% over baseline. That is the localization experiment's failure mode (context that sits beside the executive's work) and would be expensive with a pricier executive.
- **Deeper was not better (v2).** In v1, hop-2 views were edited inside as often as hop-1 views (11 each), and the hop limit ended 33 of 73 dives with P(follow) 0.69-0.89. So v2 allowed a third hop. Jev took it 19 times, and the executive never edited inside a hop-3 view. Padding short definitions to 30 lines cut re-reads only from 12 to 8. v2 raised Jev calls (5.4 → 6.7) and characters without improving steps.
- **Remaining waste.** About 0.4-0.6 delivered views per attempt are re-read, almost always a step later (11 of 12 in v1), not by a parallel call that could not have seen the dive. Some are small definitions whose module neighborhood the executive then reads (`read_file 1-175` after a 9-line `get_user`). Others are near-exact re-reads before an edit despite the "counts as read" note. Unchanged by dives: every arm calls `list_files` in 38-42 of 42 attempts and `perception` in 17-23, and about half the steps come after the first edit (edit, check, fix-test loops).
- **Latency.** Jev adds 2.1-2.5 s per attempt (0.3-1.2 s per dive), which roughly cancels the time saved by 1.3 fewer executive steps. The lexical rule has no model latency and is 4.9 s faster than baseline. The v2 slowdown on flask-4045 (dives 48-57 s vs 38-40 s) came from `run_checks` time (19-31 s vs 11-19 s) and model-time variance, not dives (3-9 s).
- **Failures are reasoning, not navigation.** In the four never-solved tasks the executive edited inside a Jev-delivered view in 23 of 24 dive attempts, then wrote a wrong fix. Dives do not change solve outcomes on this suite in either direction for Jev.

## Conclusion

The mechanism works as an architecture. It is always-on and domain-general (views, affordances, a two-question decision, read-only opening). It is bounded (characters, hops, a per-task hop budget), auditable (every dive logs candidates, probabilities and stop reasons), and it replaces executive steps: half the reads, the first edit 1.4 steps earlier, 11% fewer executive steps, equal solves. That is a modest but real improvement to the whole agent.

The decision model's specific contribution is narrower than hypothesized. On Luna, which step to take next is not the bottleneck: a trivial rule that follows the top lexical candidate saves as many steps and is faster. Jev's value is precision and restraint. It delivers the views the executive actually edits (25-29% vs 4-7%), declines well, and keeps executive context flat where the rule inflates it. It also avoided the rule's two lost solves (weak evidence: n=2, one task). That value would pay off where executive input is expensive or context windows bind, which this Luna-only experiment does not test. At Luna prices, Jev adds 45-60% to model spend ($0.0009-0.0012 per attempt) and no latency benefit.

Failure modes and limits: seven tasks from two repositories; solve outcomes are task-determined, so solve comparisons have little power. Re-reads of delivered views persist. The v2 iteration (deeper, padded) was a negative result. Candidate generation relies on Python- and brace-language heuristics (`chunkFile` anchors, indentation extents, call-site links). Choice probabilities come from independent booleans, which are conservative when several candidates are plausible. Next steps that follow from the traces: test with an expensive executive, where Jev's token restraint is priced in; make the executive-facing note stronger or the view format more edit-ready to eliminate re-reads; and treat the lexical rule as a cheap fallback when Jev is slow, keeping Jev as the gate.
