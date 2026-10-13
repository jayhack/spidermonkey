# Experiment: System 1 anticipates where the executive looks next

Status: complete on Luna (2026-10-01). Offline benchmark plus a live paired run (`.ros/evals/luna-anticipate-v3`). A GPT-6.1 Sol confirmation is complete: the gains mostly vanish with a stronger executive.

## Idea

Someone watching an expert work can usually tell where they'll look next: the definition just called, the test module for the file just read, the rest of a truncated function. If System 1 can make that prediction cheaply and knows when it's confident, the harness can execute it speculatively. It opens the predicted view now and attaches it to the current tool result, so the executive's next step goes to whatever comes after. This is branch prediction for an agent. A correct prediction saves a step. A wrong one costs a bounded amount of context and, as the perception study found, can push the executive into acting too soon. So the confidence threshold is the whole design.

## Offline benchmark

`evals/nap-bench.ts` replays recorded executive trajectories against base-commit checkouts, with no executive or Modal calls. After each executive view (`read_file` or `search`) that comes before its first edit:

1. Ordinary-code affordances (`codeAffordances` in `src/monitors/dives.ts`) propose up to 12 candidate next views.
2. Each predictor picks one. `lexical` takes the top candidate by ordinary-code prior. `dive` is the System 1 chooser from `src/attention.ts`: one Jev call per view, with P(follow) and an independent P(this is the next view) per candidate.
3. Labels come from what the executive actually did next: did it read or edit inside the predicted region in its next action, or within its next 3 actions?

```sh
npx tsx evals/nap-bench.ts --instances dev-instances.json --runs .ros/evals/dives-v1,.ros/evals/dives-v2 --predictors lexical,dive --candidates 12 --label tune
```

Tuning used `dives-v1` and `dives-v2` executive-only trajectories (Luna, 42 trajectories, 212 views). Testing used `luna-perceive-v1`, `luna-gate-v1` and `luna-gate-v2` executive-only (Luna, 263 views), plus `astra-dev-v1` and `astra-router-v1` executive-only (Astra, a different executive, 83 views; search queries weren't recorded in those runs, so only `read_file` views count).

## What limited prediction: candidate recall

Jev's first run was already near the ceiling the candidates allowed. Some candidate covered the next view in 32% of cases, and Jev's top choice was right in 30.5%. Categorizing the misses showed where the executive goes when no candidate covers it:

| Executive's next read, not covered by any candidate (tune split) | Count / 44 |
| --- | --- |
| The test module of the code it was viewing, usually its top | 25 |
| Another region of the same file | 7 |
| The top of a file from the search hits | 6 |
| A file read earlier | 6 |

Three structural affordances were added, all general rather than task-specific: the test module of a source module (named after it or importing it), the tests in that module closest to the task, and the top of a file (from a file view and from the top search-hit files). Candidate recall rose from **32% → 39% for the next view and 46% → 57% within 3 actions**.

## Results

| Split | Predictor | Opens on | Precision: next action | Precision: within 3 actions |
| --- | --- | --- | --- | --- |
| Tune (Luna, 212) | lexical top-1 | 98% | 15.9% | 22.1% |
| | Jev top-1 | 98% | 31.3% | 44.7% |
| | Jev P ≥ 0.7 | 37% | 56.4% | 71.8% |
| | Jev P ≥ 0.8 | 17% | 80.0% | 94.3% |
| **Test (Luna, 263)** | lexical top-1 | 99% | 15.4% | 18.4% |
| | Jev top-1 | 99% | 26.6% | 37.7% |
| | Jev P ≥ 0.7 | 36% | 55.4% | 66.7% |
| | **Jev P ≥ 0.8** | **15%** | **88.7%** | **94.4%** |
| **Test (Astra, 83 reads)** | lexical top-1 | 100% | 13.3% | 25.3% |
| | Jev top-1 | 100% | 20.5% | 34.9% |
| | **Jev P ≥ 0.8** | **12%** | **70.0%** | **80.0%** |

- Jev's guess is about twice as accurate as the lexical rule, and it carries over to an executive it was never tuned on.
- Its native probability is meaningful. Above 0.8, the predicted view is used within 3 actions 94% of the time (Luna) and 80% of the time (Astra).
- The live dives in `attention-dives.md` used P ≥ 0.5, which on this benchmark means only 49–54% precision. That explains their wasted context and fits the premature-commitment finding in `perception-study.md`.
- Predicting the next action's *kind* (view, search, edit, verify, finish; `src/anticipation.ts`) was no better than always guessing "view" (54% vs a 53% base rate). It was dropped.
- Cost: about $0.0002 per view (one Jev call).

## Live evaluation (`.ros/evals/luna-anticipate-v3`, Luna dev, 7 tasks × 6 repeats, paired)

Two earlier attempts were invalid because of infrastructure failures. `luna-anticipate-v1` lost 65/168 trials to a local DNS outage. `luna-anticipate-v2` lost 167/168 when long-lived Modal exec streams began failing, which led to the detached-and-poll runner. They are kept but not used.

| Profile | Solves | pytest-7490 | Steps | Executive input tokens | Reads | Views delivered / attempt | Views later edited inside | Delivered views re-read |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| executive-only | 18/42 | 6/6 | 12.31 | 80.0k | 3.02 | – | – | – |
| **anticipate** (Jev, P ≥ 0.8) | **18/42** | **6/6** | 11.24 | 68.0k | 2.67 | 1.0 | **51%** | 22% |
| anticipate-0.5 (Jev) | 17/42 | 5/6 | **10.43** | **63.5k** | 1.60 | 4.2 | 20% | 14% |
| anticipate-lexical (rule) | 18/42 | 6/6 | 10.64 | 81.7k | 1.83 | 8.1 | 4% | 7% |

Task-level paired effects vs executive-only (bootstrap over 7 tasks):

| Profile | Δ steps | Δ executive input tokens |
| --- | --- | --- |
| anticipate (P ≥ 0.8) | −1.07 (−8.7%), CI −2.6…+0.1, fewer on 5/7 | −15.0%, CI −39%…+4%, fewer on 6/7 |
| anticipate-0.5 | **−1.88 (−15.3%), CI −3.2…−0.5, fewer on 6/7** | **−20.6%, CI −39%…−5%, fewer on 6/7** |
| anticipate-lexical | −1.67 (−13.5%), CI −2.9…−0.6, fewer on 6/7 | +2.1%, CI −10%…+15%, fewer on 3/7 |

## Conclusion

- **Anticipation works live, and the decision model is what makes it efficient.** A lexical rule saves as many steps as Jev at 0.5, but it does so by flooding the executive with 8 views per attempt, of which 4% are used. Executive input stays where it was (+2%). Jev at 0.5 saves the same steps *and* 21% of executive input. At Astra prices that input is most of the bill.
- **Confidence is a dial, and the offline benchmark predicted where to set it.** At P ≥ 0.8 Jev delivers about one view per attempt, and the executive goes on to edit inside half of them. That is the clearest picture of "following along": when System 1 is sure, it is usually right about where the work will happen. The step saving is smaller and not significant on its own, with no accuracy cost. At 0.5 the saving is larger and significant, but the pytest-7490 premature-commitment failure returns (5/6). This matches the perception study: more prefetched context, more haste.
- Cost on Luna: Jev adds about $0.0013 per attempt, about 60% of Luna's own spend, so no cost claim can be made at Luna prices. With Astra, a 15–21% cut in executive input and 9–15% fewer steps should outweigh Jev's roughly $0.001 by a wide margin. That is the confirmation to run next: executive-only vs anticipate at P ≥ 0.7 (a middle setting: 36% of views delivered offline, 67–72% precision within 3 actions) and at 0.5, paired, on Astra.

## Confirmation on a stronger executive: GPT-6.1 Sol (`.ros/evals/sol61-anticipate-v1`, 7 tasks × 6 repeats, 168 trials)

`evals/suite-sol61-dev.json` (`openai/gpt-6.1-sol`, low reasoning; $2/M input, $10/M output, $0.10/M cached). Jev is about 50× cheaper per input token, so a cost saving could show up here.

| Profile | Solves | Steps | Model $ incl. Jev | Executive input tokens | Reads |
| --- | --- | --- | --- | --- | --- |
| executive-only | 27/42 | 9.29 | $0.0277 | 41.6k | 2.33 |
| anticipate (P ≥ 0.8) | 30/42 | 9.02 | $0.0267 | 42.6k | 1.74 |
| anticipate-0.7 | 26/42 | 8.98 | $0.0264 | 44.4k | 1.69 |
| anticipate-0.5 | 27/42 | 8.62 | $0.0281 | 44.8k | 1.45 |

Task-level effects vs executive-only: steps −1.9% / −1.7% / −6.1% (only 0.5's CI nearly excludes 0, at −12%…0). Cost −3.6% / −3.5% / +0.9%, with every CI spanning 0. Time +3.5–4.6%. The +3 solves at 0.8 all come from pytest-5221 (5/6 vs 1/6, p ≈ 0.08) and do not hold at the other thresholds; treated as noise.

**The Luna gains do not carry over.** Sol 6.1 is a much more efficient explorer than Luna: 9.3 vs 12.3 steps, 2.3 vs 3.0 reads, and half the input tokens. There is little wasted exploration left to anticipate, and the delivered views add input that the saved reads no longer offset. Anticipation of the executive's *own* next move helps in proportion to how much the executive wastes. The more durable lever is perception of information the executive cannot get by itself (`dynamic-world.md`), which is being re-tested with Sol 6.1 as the executive.
