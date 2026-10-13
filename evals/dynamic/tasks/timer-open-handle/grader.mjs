import { evaluate, finish, hiddenTests, record, taskPath, visibleSuite } from '../../shared/grade-lib.mjs';

// The original suite, unmodified: it never unsubscribes, so it only exits if the timer lets it.
await hiddenTests(taskPath(import.meta.url, 'files/test'), { timeoutMs: 20_000 });
await visibleSuite({ timeoutMs: 30_000 });
const exits = await evaluate(`
  const { RateLimiter } = await load('src/limiter.js');
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 20, intervalMs: 40 });
  limiter.tryRemove(2);
  const seen = [];
  limiter.onRefill(value => seen.push(value));
  setTimeout(() => report(seen), 300);
`, { timeoutMs: 5000 });
record('listeners fire on the interval', Array.isArray(exits.value) && exits.value.length >= 4, JSON.stringify(exits.value));
record('a subscribed limiter does not keep the process alive', exits.code === 0 && !exits.timedOut, exits.timedOut ? 'process did not exit within 5 s' : exits.output.slice(-300));
finish();
