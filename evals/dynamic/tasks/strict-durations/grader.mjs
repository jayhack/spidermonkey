import { finish, hiddenTests, taskPath, record, run, visibleSuite } from '../../shared/grade-lib.mjs';

await hiddenTests(taskPath(import.meta.url, 'hidden'));
await visibleSuite();
// The running scheduler must still load its real configuration with every job intact.
const schedule = await run(process.execPath, ['service/scheduler.js', '--check'], { timeoutMs: 10_000 });
let jobs;
try { jobs = Object.fromEntries(JSON.parse(schedule.output.trim().split('\n').at(-1)).map(job => [job.name, job.everyMs])); } catch {}
record('scheduler loads config/jobs.json', schedule.code === 0 && jobs, schedule.output.slice(-400));
const expected = { heartbeat: 15_000, 'flush-metrics': 30_000, 'sync-users': 300_000, 'rotate-logs': 3_600_000 };
record('every job keeps its intended interval', jobs && Object.entries(expected).every(([name, ms]) => jobs[name] === ms), JSON.stringify(jobs));
finish();
