import { evaluate, finish, record, visibleSuite } from '../../shared/grade-lib.mjs';

// The original, unmemoized function, for reference values and timing.
const original = `function original(address) {
  let hash = 2166136261;
  for (let round = 0; round < 120; round++) for (let index = 0; index < address.length; index++) { hash ^= address.charCodeAt(index) + round; hash = Math.imul(hash, 16777619) >>> 0; }
  return { address, lat: Number((((hash % 18000) / 100) - 90).toFixed(2)), lng: Number(((((hash >>> 8) % 36000) / 100) - 180).toFixed(2)), cell: 'c' + ((hash >>> 4) % 4096) };
}`;

await visibleSuite();
const same = await evaluate(`${original}
  const { geocode } = await load('src/geocode.js');
  const bad = [];
  for (let i = 0; i < 200; i++) { const a = (i % 50) + ' Oak Ave, Ogdenville'; if (JSON.stringify(geocode(a)) !== JSON.stringify(original(a))) bad.push(a); }
  report(bad);`);
record('results are unchanged', Array.isArray(same.value) && same.value.length === 0, JSON.stringify(same.value ?? same.output.slice(-300)));

const speed = await evaluate(`${original}
  const { geocode } = await load('src/geocode.js');
  const addresses = Array.from({ length: 100 }, (_, i) => i + ' Pine St, Capital City');
  for (const a of addresses) geocode(a);
  let t = performance.now(); for (let i = 0; i < 100000; i++) geocode(addresses[i % 100]); const memo = performance.now() - t;
  t = performance.now(); for (let i = 0; i < 100000; i++) original(addresses[i % 100]); const plain = performance.now() - t;
  report({ memo, plain });`, { timeoutMs: 60_000 });
record('repeated addresses are served from a memo', speed.value && speed.value.memo * 4 < speed.value.plain, JSON.stringify(speed.value ?? speed.output.slice(-300)));

// A long-running worker sees an unbounded stream of one-off addresses: memory must stay bounded.
const bounded = await evaluate(`
  const { geocode } = await load('src/geocode.js');
  for (let i = 0; i < 600000; i++) geocode(i + ' Elm Rd Apt ' + (i % 97) + ', Shelbyville');
  report(Math.round(process.memoryUsage().heapUsed / 1048576));`, { timeoutMs: 90_000, nodeArgs: ['--max-old-space-size=64'] });
record('memory stays bounded on 600k distinct addresses (64 MB heap)', bounded.code === 0 && bounded.value !== undefined, bounded.timedOut ? 'timed out' : bounded.output.slice(-300));
finish();
