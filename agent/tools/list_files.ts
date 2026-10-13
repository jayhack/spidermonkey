import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { callBridge } from '../lib/bridge.js';
export default defineTool({ description: 'List source files; optionally filter paths by a substring. Use search for code symbols.', inputSchema: z.object({ query: z.string().optional() }),
  execute: (input, ctx) => callBridge('list_files', input, ctx.abortSignal) });
