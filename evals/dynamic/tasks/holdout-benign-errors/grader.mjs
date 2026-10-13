import { finish, hiddenTests, record, run, taskPath, visibleSuite } from '../../shared/grade-lib.mjs';

await hiddenTests(taskPath(import.meta.url, 'hidden'));
await visibleSuite();
const indexer = await run(process.execPath, ['service/indexer.js', '--once'], { timeoutMs: 10_000 });
record('indexer still rebuilds', indexer.code === 0 && /rebuilt index/.test(indexer.output), indexer.output.slice(-300));
finish();
