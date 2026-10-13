# Developing Spidermonkey

Spidermonkey runs inside ROS Harness, a coding harness with two clocks: an Eve executive that plans, edits and verifies, and a System 1 loop that watches. It is built with Eve and the Vercel AI SDK. System 1 uses [Jev](https://vercel.com/ai-gateway/models/jev); the harness's own executive defaults to [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) through AI Gateway, and the Spidermonkey builder agent uses GPT-6.1 Sol. The terminal shows both lanes as they run.

The UI uses [Wave Kit](https://wave-kit.dev). The terminal's colors come from its dark palette, mapped to semantic roles in [`src/theme.ts`](../src/theme.ts).

## From a checkout

Requires Node 24+ and pnpm.

```sh
nvm install                       # if using nvm; reads .nvmrc
pnpm install
pnpm demo                         # deterministic replay, no credentials
pnpm demo --chat                  # replay + follow-up chat in the same Eve session
pnpm auth                         # verify auth; open the browser to set up a missing key
pnpm demo:live                    # real Eve executive + Jev, temporary workspace
pnpm start --workspace ./my-project --task "Find and fix the failing test"
pnpm start --workspace ./my-project # interactive coding chat
```

Use an `AI_GATEWAY_API_KEY` in `.env.local`, a Vercel OIDC token, or Eve's existing Vercel CLI connection. `pnpm auth` checks System 1 with a small Jev request and also probes the executive model when using an API key or OIDC token. If credentials are missing or expired, it opens the Gateway API keys page in your browser and prompts you to paste a key with input hidden. It verifies the key and saves it to the Git-ignored `.env.local`, preserving other settings. If Gateway requires a credit card, paid model access, or more credits, it opens the billing setup page and retries after you press Enter. In a non-interactive terminal, it prints the setup URL instead. Override models with `ROS_EXECUTIVE_MODEL` and `ROS_SYSTEM1_MODEL`. The selected Vercel team needs Gateway billing enabled; free credits alone do not grant access to every model.

For Modal evals, inject `AI_GATEWAY_API_KEY` as an environment variable with a [Modal Secret](https://modal.com/docs/guide/secrets). The harness and its Eve child process both inherit it, so a Vercel CLI login and `.env.local` are optional on Modal. Create a Secret named `ros-harness` containing that variable, then attach it to your eval function:

```python
@app.function(secrets=[modal.Secret.from_name("ros-harness")])
def run_eval():
    subprocess.run(["pnpm", "auth"], cwd="/app/ros-harness", check=True)
    # Run your eval command here; it inherits AI_GATEWAY_API_KEY too.
```

The container needs Node 24+, pnpm, the repository, and its installed dependencies. `modal` and `subprocess` in this snippet refer to imports in your eval runner. Keep `.env.local` out of the container image and Git; the same environment variable works locally, on Modal, and in CI.

`--hz 2` sets the sampling rate. `--plain` prints events without the dashboard. `--check 'pnpm test'` selects the verification command for your workspace (default: `node --test`). Live runs send bounded workspace text and tool output to AI Gateway. Replay is clearly labeled and uses scripted decisions and an executive; it exercises the same controller and filesystem tools.

The left pane is a coding transcript: activity labels, grouped tools, check summaries, edit previews, and streamed assistant replies. In chat mode, Enter submits, Alt+Enter adds a line, and Up/Down recalls prompts. You can type while the agent works; submitted follow-ups queue for the next turn. `/exit` or Ctrl+C exits. Use `--chat` with `--task` to start with a task and keep the conversation open afterward. Eve retains the same conversation across turns, and System 1 continues watching while you compose.

System 1 shows the latest non-wait result with its target, action and file confidence, execution threshold, observed context, and outcome. `Held` means the harness did not act. `Read` and `Escalated` show evidence added to the perception board. The activity table aligns time, result, and what happened; white rows mark completed actions. Waiting and held rows are gray. Repeated activity collapses in the dashboard while every frame remains in the trace.

To publish the CLI to npm as `@jayhack/spidermonkey`: bump `version` in `package.json`, then run `npm publish` (it ships `bin/`, `src/` and the builder agent; tsx compiles the TypeScript on load).

## How the harness works

The CLI owns a snapshot loop and a local tool bridge. Eve runs the executive. Every tool result triggers a fresh System 1 evaluation before returning to Eve; timer frames keep watching while the executive is busy. Jev selects from a fixed action set: wait, read a candidate file, or escalate. High probability reads are confined to the workspace. Findings return inside tool results, and the executive can fetch the current perception board.

Frames coalesce while an evaluation is in flight. File changes invalidate old observations and verification; stale decisions are discarded. Reads and escalations are deduplicated, reflexes have a budget, and only the executive can write or run checks. The right pane displays decisions and observed activity; it does not invent hidden reasoning. Each run saves a JSONL event trace in `.ros/runs/`.

See [architecture](architecture.md) for extension points, [hill-climbing results and contributor experiments](../hill-climbing.md), and [the Modal SWE-bench loop](../evals/README.md) to tune System 1 against measured solve rate, time, and cost. Run `pnpm eval:run --calibrate`, then `pnpm eval:run`. Use `--tuning evals/profiles/focused-budgeted.json` to try a policy interactively.
