import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { callBridge } from '../lib/bridge.js';
export default defineTool({
  description: 'Talk to Spidermonkey, your always-on System 1. action "watch" registers something to monitor: a command to re-run (command, name, everySeconds), a file, a port, or an app, with priority focus|watch|background. "unwatch" removes an id. "status" lists what it is watching. "findings" returns undelivered findings now.',
  inputSchema: z.object({
    action: z.enum(['watch', 'unwatch', 'status', 'findings']),
    command: z.string().optional(), name: z.string().optional(), everySeconds: z.number().int().min(5).max(600).optional(),
    file: z.string().optional(), port: z.number().int().optional(), app: z.string().optional(), id: z.string().optional(),
    priority: z.enum(['focus', 'watch', 'background']).optional(), reason: z.string().optional(),
  }),
  execute: (input, ctx) => callBridge('spidermonkey', input, ctx.abortSignal) });
