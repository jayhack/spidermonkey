// Offline System 1 localization benchmark. The localizer sees only the issue and the
// checked-out repository; gold hunks are read here, by the scorer, after selection.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadModelEnvironment } from '../src/auth.js';
import { defaultLocalizeOptions, indexWorkspace, jevScorer, localize, testPath, type Chunk, type LocalizeOptions } from '../src/localize.js';
import { defaultSystem1Model } from '../src/models.js';
import { Workspace } from '../src/workspace.js';

type Hunk = { path: string; start: number; end: number };
type Instance = { instance_id: string; repo: string; split: string; workspace: string; task: string; gold: Hunk[]; tests: Hunk[] };

const { values } = parseArgs({ options: {
  instances: { type: 'string', default: '.ros/localization/instances.json' },
  split: { type: 'string', default: 'tune' }, mode: { type: 'string', default: 'jev' },
  options: { type: 'string', default: '{}' }, concurrency: { type: 'string', default: '6' },
  limit: { type: 'string' },
} });
loadModelEnvironment();
const options: LocalizeOptions = { ...defaultLocalizeOptions, ...JSON.parse(values.options!) };
let instances = (JSON.parse(await readFile(values.instances!, 'utf8')) as Instance[])
  .filter(item => values.split === 'all' || item.split === values.split);
if (values.limit) instances = instances.slice(0, Number(values.limit));
const scorer = values.mode === 'jev' ? jevScorer(process.env.ROS_SYSTEM1_MODEL || defaultSystem1Model, options.previewLines) : undefined;
const covers = (chunks: Chunk[], hunk: Hunk) => chunks.some(chunk => chunk.path === hunk.path && chunk.startLine <= hunk.end && chunk.endLine >= hunk.start);

async function score(item: Instance) {
  const started = performance.now();
  const workspace = new Workspace(item.workspace);
  const index = await indexWorkspace(workspace, item.task);
  let trace: Awaited<ReturnType<typeof localize>> | undefined, error: string | undefined;
  try { trace = await localize(index, item.task, options, scorer, AbortSignal.timeout(60_000)); }
  catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  const candidates = (trace?.candidates ?? []).filter(chunk => chunk.kind !== 'test'), ranked = candidates;
  const delivered = (trace?.delivered ?? []).filter(chunk => chunk.kind !== 'test');
  const deliveredTests = (trace?.delivered ?? []).filter(chunk => chunk.kind === 'test');
  const inputTokens = trace?.inputTokens ?? 0, costUsd = error ? undefined : trace?.costUsd;
  const goldFiles = [...new Set(item.gold.map(hunk => hunk.path))];
  const fileOrder = [...(trace?.files ?? [])].filter(file => !testPath.test(file.path)).sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0)).map(file => file.path);
  const fileRank = Math.min(...goldFiles.map(path => { const at = fileOrder.indexOf(path); return at < 0 ? Infinity : at + 1; }));
  const gold = item.gold;
  const hit = gold.filter(hunk => covers(delivered, hunk)).length;
  const bestRank = Math.min(...gold.map(hunk => {
    const order = [...ranked].sort((a, b) => (b.probability ?? b.lexical) - (a.probability ?? a.lexical));
    const index = order.findIndex(chunk => covers([chunk], hunk));
    return index < 0 ? Infinity : index + 1;
  }));
  return {
    id: item.instance_id, repo: item.repo, error, fileRank, fileCandidate: Number.isFinite(fileRank), latencyMs: Math.round(performance.now() - started), inputTokens, costUsd,
    candidateRecall: gold.filter(hunk => covers(candidates, hunk)).length / gold.length,
    recall: hit / gold.length, anyHit: hit > 0, allHit: hit === gold.length, bestRank,
    fileHit: gold.some(hunk => delivered.some(chunk => chunk.path === hunk.path)),
    testHit: item.tests.some(hunk => covers(deliveredTests, hunk)),
    testFileHit: item.tests.some(hunk => deliveredTests.some(chunk => chunk.path === hunk.path)),
    testNear: item.tests.some(hunk => deliveredTests.some(chunk => chunk.path === hunk.path && chunk.startLine - 40 <= hunk.end && chunk.endLine + 40 >= hunk.start)),
    testChars: deliveredTests.reduce((sum, chunk) => sum + chunk.text.length, 0),
    chunks: delivered.length, chars: delivered.reduce((sum, chunk) => sum + chunk.text.length, 0),
    delivered: [...delivered, ...deliveredTests].map(chunk => `${chunk.path}:${chunk.startLine}-${chunk.endLine}@${(chunk.probability ?? 0).toFixed(2)}`),
    gold: [...gold, ...item.tests].map(hunk => `${hunk.path}:${hunk.start}-${hunk.end}`),
  };
}

const results: Awaited<ReturnType<typeof score>>[] = [];
const queue = [...instances];
await Promise.all(Array.from({ length: Number(values.concurrency) }, async () => {
  for (let item = queue.shift(); item; item = queue.shift()) results.push(await score(item));
}));
results.sort((a, b) => a.id.localeCompare(b.id));
const mean = (pick: (row: typeof results[number]) => number) => results.reduce((sum, row) => sum + pick(row), 0) / Math.max(1, results.length);
const summary = {
  mode: values.mode, split: values.split, n: results.length, options,
  errors: results.filter(row => row.error).length,
  candidateRecall: mean(row => row.candidateRecall), recall: mean(row => row.recall),
  anyHit: mean(row => Number(row.anyHit)), allHit: mean(row => Number(row.allHit)), fileHit: mean(row => Number(row.fileHit)),
  fileCandidate: mean(row => Number(row.fileCandidate)), fileTop1: mean(row => Number(row.fileRank === 1)), fileTop3: mean(row => Number(row.fileRank <= 3)),
  testHit: mean(row => Number(row.testHit)), testFileHit: mean(row => Number(row.testFileHit)), testNear: mean(row => Number(row.testNear)), testChars: mean(row => row.testChars), top1: mean(row => Number(row.bestRank === 1)), top3: mean(row => Number(row.bestRank <= 3)),
  chunks: mean(row => row.chunks), chars: mean(row => row.chars),
  costUsd: results.every(row => row.costUsd !== undefined) ? results.reduce((sum, row) => sum + row.costUsd!, 0) : null,
  latencyMs: mean(row => row.latencyMs),
};
for (const row of results) console.log(`${row.anyHit ? 'HIT ' : 'miss'} ${row.id.padEnd(36)} frank=${String(row.fileRank).padEnd(3)} rank=${String(row.bestRank).padEnd(3)} cand=${row.candidateRecall.toFixed(2)} ${row.delivered.join(' ')} | gold ${row.gold.join(' ')}${row.error ? ` ERROR ${row.error.slice(0, 120)}` : ''}`);
console.log(JSON.stringify(summary, null, 2));
const directory = resolve('.ros/localization/runs');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, `${new Date().toISOString().replace(/[:.]/g, '')}-${values.mode}-${values.split}.json`), JSON.stringify({ summary, results }, null, 2));
