// Simulated API dev server: serves synthetic traffic and logs like a busy service.
//   node service/api.js          run forever
//   node service/api.js --once   run a few seconds of traffic and exit
import { mean } from '../src/stats.js';

let seed = 11;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = items => items[Math.floor(random() * items.length)];
const log = (level, component, message) => console.log(`${new Date().toISOString()} ${level} ${component}: ${message}`);
const latencies = [];
let ticks = 0;

log('INFO', 'http', 'listening on 127.0.0.1:4410 (dev)');
log('WARN', 'deps', `(node:${process.pid}) [DEP0040] DeprecationWarning: The \`punycode\` module is deprecated. Please use a userland alternative instead.`);

function request() {
  const route = pick(['/health', '/api/orders', `/api/orders/${1000 + Math.floor(random() * 900)}`, '/api/customers/me', '/api/cart']);
  const status = route.startsWith('/api/orders/') && random() < 0.08 ? 404 : 200;
  const ms = Math.round(2 + random() * (route === '/health' ? 3 : 40));
  latencies.push(ms);
  if (latencies.length > 200) latencies.shift();
  log(status === 200 ? 'INFO' : 'WARN', 'http', `GET ${route} ${status} ${ms}ms`);
}

function background() {
  ticks += 1;
  if (ticks % 12 === 0) log('INFO', 'stats', `window=${latencies.length} mean_latency=${mean(latencies).toFixed(1)}ms`);
  if (ticks % 16 === 5) log('ERROR', 'metrics-exporter', `push to statsd 127.0.0.1:8125 failed: connect ECONNREFUSED 127.0.0.1:8125 (will retry in 5s)`);
  if (ticks % 40 === 23) log('WARN', 'pool', `slow query ${900 + Math.floor(random() * 700)}ms: SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC`);
  if (ticks % 64 === 37) log('WARN', 'gc', `pause ${150 + Math.floor(random() * 120)}ms (heap ${40 + Math.floor(random() * 20)}MB)`);
  if (ticks % 90 === 71) log('ERROR', 'payments-webhook', `signature mismatch for event evt_${Math.floor(random() * 1e6)} from 10.0.3.7 (rejected, sender will retry)`);
  if (ticks % 110 === 97) log('WARN', 'cache', `redis latency spike: GET session:* p99=${80 + Math.floor(random() * 60)}ms`);
}

const traffic = setInterval(request, 250);
const chores = setInterval(background, 250);
if (process.argv.includes('--once')) setTimeout(() => { clearInterval(traffic); clearInterval(chores); log('INFO', 'http', 'shutdown'); }, 3000);
