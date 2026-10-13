# Spidermonkey

**An always-on System 1 for coding agents.**

https://github.com/user-attachments/assets/325e649e-1354-4e1f-947b-f123e1eda53f

Coding agents work one step at a time and only see what their tool results show them, but the machine around them is live and chaotic. Spidermonkey gives the agent a fast, cheap System 1 that watches everything and steers its attention to what matters. It's a research prototype exploring an idea, not a daily driver.

## How it works

1. **Perceive.** Every couple of seconds, sample the machine (processes, memory, ports, logs, watched commands) and the agent's own trace.
2. **Find order.** Plain code keeps what changed; one call to a small decision model ([Jev](https://vercel.com/ai-gateway/models/jev)) judges what matters, and how urgently.
3. **Steer attention.** A **note** on the agent's next tool result, an **interrupt** when it's stuck on a command, or a **wake** when something breaks after it's done.

It's read-only: it never edits files or stops other programs.

## What we found

- **It helps most where the agent is blind.** Hung test runs stopped after about 15 s instead of 90 (−54%), with no false interrupts, on GPT-6.1 Sol.
- **Weaker models gain more.** On 7 SWE-bench Lite tasks it saved GPT-6 Luna steps; GPT-6.1 Sol barely needed the help.
- **It's cheap.** About $0.00007 per judgment: $0.003 of System 1 beside $0.20 of executive in the demo.

## Try it

Needs Node 24+ and a [Vercel AI Gateway](https://vercel.com/ai-gateway) key.

```sh
npm install -g github:jayhack/spidermonkey
spidermonkey auth      # connect AI Gateway
spidermonkey demo      # the agent builds a web app while its storage service fails
spidermonkey ui        # Spidermonkey alone, watching your machine
spidermonkey           # the agent, on the current directory
```

## Learn more

- [How Spidermonkey works](docs/spidermonkey.md)
- [The experiments](docs/experiments/), including what didn't work
- [Running the harness from a checkout](docs/development.md)
- [The explainer's source](explainer/)
