import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { callBridge } from '../lib/bridge.js';

export default defineTool({
  description: 'Read a relative demo source file and receive System 1 observations.',
  inputSchema: z.object({ path: z.string() }),
  execute: (input, ctx) => callBridge('read_file', input, ctx.abortSignal),
});
