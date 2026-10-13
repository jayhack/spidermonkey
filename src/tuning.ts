import { readFile } from 'node:fs/promises';
import { z } from 'zod';

// This is the search space shared by the CLI and the real benchmark runner.
export const tuningSchema = z.object({
  enabled: z.boolean().default(true),
  hz: z.number().min(0.1).max(20).default(2),
  threshold: z.number().min(0).max(1).default(0.85),
  skipUnchanged: z.boolean().default(true),
  rankCandidates: z.boolean().default(true),
  targetMode: z.enum(['choice', 'relevance']).default('choice'),
  candidates: z.number().int().min(1).max(64).default(24),
  observationCount: z.number().int().min(0).max(12).default(4),
  observationChars: z.number().int().min(256).max(16_000).default(4000),
  toolOutputChars: z.number().int().min(256).max(16_000).default(8000),
  boardChars: z.number().int().min(1024).max(64_000).default(16_000),
  reflexBudget: z.number().int().min(0).max(64).default(8),
  reflexChain: z.number().int().min(0).max(8).default(0),
  maxFrames: z.number().int().min(1).max(1000).default(96),
  timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
  instructions: z.string().max(4000).default(''),
  // false: no timer frames or post-tool reflexes; System 1 acts only at turn start.
  continuous: z.boolean().default(true),
  // Pre-first-call localization: System 1 scores files and definitions, the
  // controller delivers the selected source. See src/localize.ts.
  localize: z.object({
    files: z.number().int().min(1).max(64), expandFiles: z.number().int().min(1).max(8),
    fileThreshold: z.number().min(0).max(1), perFile: z.number().int().min(1).max(64),
    previewLines: z.number().int().min(5).max(200), threshold: z.number().min(0).max(1),
    floor: z.number().min(0).max(1), budgetChars: z.number().int().min(500).max(32_000),
    maxChunks: z.number().int().min(1).max(12), testFiles: z.number().int().min(0).max(32),
    testPerFile: z.number().int().min(1).max(64), testThreshold: z.number().min(0).max(1),
    testBudgetChars: z.number().int().min(0).max(16_000), testMaxChunks: z.number().int().min(0).max(4),
  }).partial().strict().optional(),
  // Always-on monitors by registry name (src/monitors/index.ts), each with its own config.
  monitors: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  // Longest a tool result waits for in-flight monitor work before returning (0: never wait).
  deliverWaitMs: z.number().int().min(0).max(300_000).default(0),
  // Follow-up turns a monitor's final gate may request after the executive answers.
  followUps: z.number().int().min(0).max(3).default(0),
  monitorTickMs: z.number().int().min(100).max(60_000).default(1000),
  // Builder tools for the web-app demo agent: create files, run commands, background processes.
  builder: z.boolean().default(false),
  // Step-level deliberation routing: System 1 decides when the strong model is needed.
  router: z.object({
    fast: z.string(), strong: z.string(),
    mode: z.enum(['system1', 'random', 'always-fast', 'always-strong']).default('system1'),
    threshold: z.number().min(0).max(1).default(0.5),
    rate: z.number().min(0).max(1).default(0.3),
  }).strict().optional(),
}).strict();
export type Tuning = z.infer<typeof tuningSchema>;
export async function loadTuning(path?: string): Promise<Tuning> {
  return tuningSchema.parse(path ? JSON.parse(await readFile(path, 'utf8')) : {});
}

// Return observed source lines, centered on an issue location or matching code.
// Large docstrings at the top of a file should not consume the entire board.
export function excerptObservation(path: string, content: string, budget: number, task: string) {
  const lines = content.split('\n');
  if (content.length <= budget) return { path, content, startLine: 1, endLine: lines.length, totalLines: lines.length, truncated: false };
  const filename = path.split('/').at(-1)!;
  const location = [...task.matchAll(/([\w/.-]+\.(?:py|ts|js|go|rs)):(\d+)/g)]
    .find(match => match[1] === path || match[1]!.endsWith(`/${filename}`) || match[1] === filename);
  const words = new Set(task.toLowerCase().match(/[a-z_][a-z_0-9]{2,}/g) ?? []);
  let center = location ? Math.max(0, Math.min(lines.length - 1, Number(location[2]) - 1)) : 0;
  if (!location) {
    let best = 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!/^\s*(?:def |class |(?:async )?function |(?:export )?(?:const|let) |if |return |[\w.]+\s*=)/.test(line)) continue;
      const score = (line.toLowerCase().match(/[a-z_][a-z_0-9]{2,}/g) ?? []).filter(word => words.has(word)).length;
      if (score > best) { best = score; center = index; }
    }
  }
  let start = center, end = center + 1;
  let size = lines[center]!.length;
  // Grow both sides so callers see the surrounding function and exact line numbers.
  while (start > 0 || end < lines.length) {
    let progressed = false;
    if (start > 0 && size + lines[start - 1]!.length + 1 <= budget) { size += lines[--start]!.length + 1; progressed = true; }
    if (end < lines.length && size + lines[end]!.length + 1 <= budget) { size += lines[end++]!.length + 1; progressed = true; }
    if (!progressed) break;
  }
  return { path, content: lines.slice(start, end).join('\n').slice(0, budget), startLine: start + 1,
    endLine: end, totalLines: lines.length, truncated: true };
}

export function rankCandidates(files: string[], task: string, recentTool: unknown): string[] {
  const evidence = `${task}\n${JSON.stringify(recentTool) ?? ''}`.toLowerCase();
  const words = new Set(evidence.match(/[a-z_][a-z_0-9]{2,}/g) ?? []);
  const score = (path: string) => {
    const lower = path.toLowerCase();
    const parts = lower.replace(/\.[^.]+$/, '').split(/[\/_.-]/);
    return (evidence.includes(lower) ? 100 : 0) + parts.reduce((sum, part) => sum + (words.has(part) ? 5 : 0), 0)
      + (/\.(py|ts|js|go|rs)$/.test(lower) ? 1 : 0) - (/^(docs|doc|examples)\//.test(lower) ? 1 : 0);
  };
  const scores = new Map(files.map(path => [path, score(path)]));
  return [...files].sort((a, b) => scores.get(b)! - scores.get(a)! || a.localeCompare(b));
}
