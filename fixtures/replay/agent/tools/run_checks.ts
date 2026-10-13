import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { callBridge } from '../lib/bridge.js';

export default defineTool({
  description: 'Run the demo verification command and return its exit code, output, and System 1 findings.',
  inputSchema: z.object({}),
  execute: (input, ctx) => callBridge('run_checks', input, ctx.abortSignal),
});
