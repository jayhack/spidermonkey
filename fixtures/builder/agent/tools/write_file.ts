import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { callBridge } from '../lib/bridge.js';
export default defineTool({ description: 'Create a new file, or replace an existing file you have read, with the full content. Parent directories are created.',
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  execute: (input, ctx) => callBridge('write_file', input, ctx.abortSignal) });
