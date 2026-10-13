import { finish, hiddenTests, record, run, taskPath, visibleSuite } from '../../shared/grade-lib.mjs';

await hiddenTests(taskPath(import.meta.url, 'hidden'));
await visibleSuite();
const api = await run(process.execPath, ['service/api.js', '--once'], { timeoutMs: 10_000 });
record('api server still runs', api.code === 0 && !api.timedOut, api.output.slice(-300));
finish();
