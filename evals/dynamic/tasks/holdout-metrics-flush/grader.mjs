import { evaluate, finish, hiddenTests, record, taskPath, visibleSuite } from '../../shared/grade-lib.mjs';

// The original suite closes every server; it must then exit on its own.
await hiddenTests(taskPath(import.meta.url, 'files/test'), { timeoutMs: 20_000 });
await visibleSuite({ timeoutMs: 30_000 });
const closed = await evaluate(`
  const { startServer } = await load('src/server.js');
  const seen = [];
  const server = await startServer({ flushIntervalMs: 30, onFlush: snapshot => seen.push(snapshot) });
  await new Promise(resolve => setTimeout(resolve, 120));
  await server.close();
  report(seen.length);
`, { timeoutMs: 5000 });
record('flushes run until close', typeof closed.value === 'number' && closed.value >= 2, String(closed.value));
record('a closed server lets the process exit', closed.code === 0 && !closed.timedOut, closed.timedOut ? 'process did not exit within 5 s of close()' : closed.output.slice(-300));
finish();
