import { finish, hiddenTests, taskPath, visibleSuite } from '../../shared/grade-lib.mjs';

// The original suite states the requirements, including the last-page case.
await hiddenTests(taskPath(import.meta.url, 'files/test'), { timeoutMs: 20_000 });
await visibleSuite({ timeoutMs: 30_000 });
finish();
