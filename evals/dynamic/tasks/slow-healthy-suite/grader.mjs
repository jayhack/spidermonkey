import { finish, hiddenTests, taskPath, visibleSuite } from '../../shared/grade-lib.mjs';

await hiddenTests(taskPath(import.meta.url, 'hidden'));
// The original suite, including the time-boxed soak test, must still pass unmodified.
await hiddenTests(taskPath(import.meta.url, 'files/test'), { timeoutMs: 60_000 });
await visibleSuite({ timeoutMs: 60_000 });
finish();
