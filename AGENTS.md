# Working on ROS Harness

Keep v0 focused on two clocks: an Eve executive and a bounded System 1 perception loop.

- `src/controller.ts` owns scheduling, reflex policy, and the perception board.
- `src/system1.ts` owns typed decision-model requests. Check installed AI SDK docs before changing its experimental API.
- `agent/` is the live Eve executive. Read `node_modules/eve/docs/README.md` and the relevant guide before changing authored definitions.
- `fixtures/replay/` is a deterministic Eve executive for the no-key demo.
- `src/perception.ts` is the always-on perceptual system: sensors, one System 1 appraisal, attention routing. `docs/experiments/` records experiments.
- `src/attention.ts` is the domain-general dive engine (views, affordances, System 1 follow/which decisions); `src/monitors/dives.ts` supplies code affordances and delivers dives on `read_file`/`search` results.
- `src/spidermonkey/` is the standalone always-on System 1 daemon and CLI (`pnpm spidermonkey`); see `docs/spidermonkey.md`. It observes and reports; it never writes files or stops processes.
- `src/dashboard.ts` displays observed events and probabilities. Do not label generated or invented text as hidden reasoning.

Use [Wave Kit](https://wave-kit.dev) for the project's visual language. The CLI maps its dark palette to ANSI colors in `src/theme.ts`; reuse those semantic roles instead of adding ad hoc colors. Highlight completed System 1 reads and escalations in white; keep waiting, held proposals, and background activity gray. Read scores use blue, escalation scores amber, and failures red. Future web interfaces should use `@jayhack/wave-kit` components and tokens.

Use Node 24+. Run `pnpm typecheck`, `pnpm test`, and `pnpm demo --plain` after runtime changes. Check `pnpm exec eve info --json` after changing `agent/`.

System 1 remains read-only: only the executive writes workspace files. Perception sensors (`src/perception.ts`, `src/monitors/`) may run profile-configured observation commands in the background, including the user-selected check, and may answer `run_checks` only with an observation of the same command at the current edit revision. Its one action on the world is the interrupt: when it judges the executive's blocking `run_checks` stuck, the harness stops that command's process group, returns the partial output with the finding, and records a `system1/interrupt` event. It never stops services or other processes. Keep credentials, runtime state, and traces out of Git. Preserve the distinction between replay, scripted (`evals/dynamic --scripted`), and live model calls.
