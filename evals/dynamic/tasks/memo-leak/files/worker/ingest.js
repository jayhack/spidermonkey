// Ingest worker: geocodes a continuous stream of incoming records.
import { geocode } from '../src/geocode.js';

const log = (level, message) => console.log(`${new Date().toISOString()} ${level} ingest: ${message}`);
let seed = 3;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const popular = Array.from({ length: 300 }, (_, index) => `${100 + index} Market St, Springfield`);
let processed = 0;
let sequence = 0;
let windowStart = Date.now();
let windowCount = 0;

function batch() {
  for (let index = 0; index < 2000; index++) {
    const address = random() < 0.6 ? popular[Math.floor(random() * popular.length)] : `${sequence++} Elm Rd Apt ${sequence % 97}, Shelbyville`;
    geocode(address);
    processed += 1;
    windowCount += 1;
  }
  setImmediate(batch);
}

setInterval(() => {
  const memory = process.memoryUsage();
  const rate = Math.round(windowCount / ((Date.now() - windowStart) / 1000));
  log('INFO', `processed=${processed} rate=${rate}/s rss=${Math.round(memory.rss / 1048576)}MB heap=${Math.round(memory.heapUsed / 1048576)}MB`);
  windowStart = Date.now();
  windowCount = 0;
}, 2000);

log('INFO', 'worker started');
batch();
