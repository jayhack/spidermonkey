import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { callBridge } from '../lib/bridge.js';

export default defineTool({
  description: 'Fetch the current System 1 board, read-only reflex observations, and escalations.',
  inputSchema: z.object({}),
  execute: (input, ctx) => callBridge('perception', input, ctx.abortSignal),
});
