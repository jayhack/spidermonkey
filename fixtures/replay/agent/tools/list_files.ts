import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { callBridge } from '../lib/bridge.js';

export default defineTool({
  description: 'List the demo workspace source files and receive System 1 observations.',
  inputSchema: z.object({}),
  execute: (input, ctx) => callBridge('list_files', input, ctx.abortSignal),
});
