import { finish, hiddenTests, taskPath, visibleSuite } from '../../shared/grade-lib.mjs';

await hiddenTests(taskPath(import.meta.url, 'hidden'));
await visibleSuite();
finish();
