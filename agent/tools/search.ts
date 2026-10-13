import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { callBridge } from '../lib/bridge.js';
export default defineTool({ description: 'Search source files for a literal substring. Returns bounded matching lines and paths. Read the relevant file before editing.',
  inputSchema: z.object({ query: z.string().min(1).max(200) }),
  execute: (input, ctx) => callBridge('search', input, ctx.abortSignal) });
