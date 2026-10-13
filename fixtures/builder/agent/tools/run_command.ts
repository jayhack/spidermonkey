import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { callBridge } from '../lib/bridge.js';
export default defineTool({ description: 'Run a shell command in the workspace and wait for it (tests, curl, node scripts). Bounded by timeoutSeconds (default 60, max 180). Use start_process for servers and anything long-running.',
  inputSchema: z.object({ command: z.string().min(1), timeoutSeconds: z.number().int().min(1).max(180).optional() }),
  execute: (input, ctx) => callBridge('run_command', input, ctx.abortSignal) });
