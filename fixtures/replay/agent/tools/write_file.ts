import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { callBridge } from '../lib/bridge.js';

export default defineTool({
  description: 'Replace an existing demo source file after reading it, with an optimistic version check.',
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  execute: (input, ctx) => callBridge('write_file', input, ctx.abortSignal),
});
