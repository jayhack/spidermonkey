import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { callBridge } from '../lib/bridge.js';
export default defineTool({ description: 'Stop a background process started with start_process (its whole process group).',
  inputSchema: z.object({ name: z.string() }),
  execute: (input, ctx) => callBridge('stop_process', input, ctx.abortSignal) });
