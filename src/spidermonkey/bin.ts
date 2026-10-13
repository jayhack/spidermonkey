import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { authenticate, loadModelEnvironment } from '../auth.js';
import { defaultSystem1Model } from '../models.js';
import { credentialsPath, packageRoot, stateHome, workspaceKey } from '../paths.js';
import { terminalTheme as t } from '../theme.js';

// The installed `spidermonkey` command: a coding agent with Spidermonkey as its System 1.
// Machine-watching subcommands (ui, start, watch, ...) are handled by ./cli.ts.

const usage = `${t.bright}spidermonkey${t.reset} ${t.dim}a coding agent with an always-on System 1${t.reset}

  spidermonkey auth                 connect AI Gateway (saves a key to ${credentialsPath})
  spidermonkey [--task TEXT]        start the agent on the current directory (interactive chat)
               [--check "CMD"] [--plain] [--workspace DIR]
  spidermonkey demo                 the web-app demo: the agent builds an app while storage fails

  Spidermonkey alone, watching this machine:
  spidermonkey ui | start | watch | unwatch | status | drain | trace     (spidermonkey ui --help)

Enter submits; Alt+Enter adds a line; /exit or Ctrl+C exits. Runs are saved in ${join(stateHome, 'runs')}.`;

const monkeyCommands = new Set(['ui', 'start', 'watch', 'unwatch', 'status', 'drain', 'trace']);
const authHint = 'Run "spidermonkey auth" to connect AI Gateway. The Vercel team needs Gateway billing enabled.';
const command = process.argv[2];

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(`spidermonkey needs Node 24 or newer (this is ${process.version}).`);
  process.exit(1);
}

if (command && monkeyCommands.has(command)) {
  await import('./cli.js');
} else if (command === 'auth') {
  loadModelEnvironment();
  try {
    await authenticate({ keyPath: credentialsPath, command: 'spidermonkey auth' });
    console.log(`${t.bright}Connected.${t.reset} ${t.dim}System 1: ${process.env.ROS_SYSTEM1_MODEL || defaultSystem1Model}. Run "spidermonkey" in a project to start.${t.reset}`);
  } catch (error) {
    console.error(`${t.danger}Gateway connection failed:${t.reset} ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log(usage);
} else if (command === '--version' || command === '-v') {
  console.log((JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version);
} else if (command === undefined || command === 'demo' || command.startsWith('-')) {
  const { values } = parseArgs({ args: process.argv.slice(command === 'demo' ? 3 : 2), options: {
    task: { type: 'string' }, check: { type: 'string' }, plain: { type: 'boolean' }, workspace: { type: 'string' },
  } });
  const { runHarness } = await import('../cli.js');
  const runsDir = join(stateHome, 'runs');
  try {
    if (command === 'demo') await runHarness({ web: true, plain: values.plain, runsDir, authHint });
    else {
      const workspace = resolve(values.workspace ?? '.');
      await runHarness({
        workspace, task: values.task, chat: true, plain: values.plain, check: values.check ?? detectCheck(workspace), runsDir, authHint,
        timeoutMs: 30 * 60_000,
        profile: {
          builder: true, continuous: false, followUps: 1, timeoutMs: 20_000,
          monitors: { spidermonkey: { intervalMs: 2000, callsPerMinute: 20, appraiser: 'system1', home: join(stateHome, 'sessions', workspaceKey(workspace)) } },
        },
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else {
  console.error(`Unknown command "${command}".\n\n${usage}`);
  process.exitCode = 1;
}

/** The workspace's own test command when it declares one. */
function detectCheck(root: string) {
  const manifest = join(root, 'package.json');
  if (existsSync(manifest)) {
    try {
      const scripts = (JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, string> }).scripts;
      if (scripts?.test) return 'npm test';
    } catch { /* An unreadable manifest falls back to node --test. */ }
  }
  return 'node --test';
}
