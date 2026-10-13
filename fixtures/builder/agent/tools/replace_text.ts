import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { callBridge } from '../lib/bridge.js';
export default defineTool({ description: 'Make a small edit to an already read file. oldText must match exactly once; rejects stale reads. Prefer this to rewriting an entire file.',
  inputSchema: z.object({ path: z.string(), oldText: z.string().min(1), newText: z.string() }),
  execute: (input, ctx) => callBridge('replace_text', input, ctx.abortSignal) });
