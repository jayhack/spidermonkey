import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { callBridge } from '../lib/bridge.js';
export default defineTool({ description: 'Start a long-running background process (dev server, worker) in the workspace. Output goes to logs/<name>.log. Spidermonkey watches it automatically.',
  inputSchema: z.object({ name: z.string().regex(/^[\w.-]{1,40}$/), command: z.string().min(1) }),
  execute: (input, ctx) => callBridge('start_process', input, ctx.abortSignal) });
