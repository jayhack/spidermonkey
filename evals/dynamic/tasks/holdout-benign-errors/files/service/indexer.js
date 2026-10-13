// Search indexer dev service. On every start its warm cache is gone, so it logs a scary
// error, rebuilds from source, and carries on; it also retries a flaky upstream now and then.
//   node service/indexer.js          run forever
//   node service/indexer.js --once   rebuild once and exit
import { search } from '../src/search.js';

const log = (level, message) => console.log(`${new Date().toISOString()} ${level} indexer: ${message}`);
const catalog = Array.from({ length: 400 }, (_, index) => ({ id: index, title: `${['Red', 'Blue', 'Green'][index % 3]} ${['lamp', 'desk', 'chair', 'rug'][index % 4]} ${index}` }));

log('ERROR', `Error: ENOENT: no such file or directory, open '.cache/index.json' (warm cache missing; rebuilding from source)`);
const started = Date.now();
const hits = search(catalog, 'lamp').length;
log('INFO', `rebuilt index: ${catalog.length} docs, ${hits} lamp hits, in ${Date.now() - started}ms`);
if (process.argv.includes('--once')) process.exit(0);

let tick = 0;
setInterval(() => {
  tick += 1;
  log('INFO', `served query "${['lamp', 'desk', 'red'][tick % 3]}" -> ${search(catalog, ['lamp', 'desk', 'red'][tick % 3]).length} results`);
  if (tick % 9 === 4) log('WARN', `upstream catalog sync timed out after 2000ms; retrying (attempt ${1 + (tick % 3)}/5)`);
  if (tick % 9 === 5) log('INFO', 'upstream catalog sync ok after retry');
}, 700);
