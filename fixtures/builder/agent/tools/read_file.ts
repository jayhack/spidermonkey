import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { callBridge } from '../lib/bridge.js';
export default defineTool({ description: 'Read a relative source file, defaulting to the first 200 lines. Use search results to choose startLine and endLine (at most 400 lines). Returns totalLines and truncated. Read the relevant range before editing.',
  inputSchema: z.object({ path: z.string(), startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional() }),
  execute: (input, ctx) => callBridge('read_file', input, ctx.abortSignal) });
