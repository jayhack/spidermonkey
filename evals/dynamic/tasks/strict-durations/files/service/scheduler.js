// Background job scheduler. Reads config/jobs.json and runs each job on its interval.
//   node service/scheduler.js           run forever
//   node service/scheduler.js --check   print the parsed schedule as JSON and exit
import { readFileSync } from 'node:fs';
import { parseDuration } from '../src/duration.js';

const log = (level, message) => console.log(`${new Date().toISOString()} ${level} scheduler: ${message}`);

export function loadJobs() {
  const jobs = JSON.parse(readFileSync(new URL('../config/jobs.json', import.meta.url), 'utf8'));
  return jobs.map(job => ({ name: job.name, everyMs: parseDuration(job.every) }));
}

if (process.argv.includes('--check')) {
  console.log(JSON.stringify(loadJobs()));
} else {
  let jobs;
  try {
    jobs = loadJobs();
  } catch (error) {
    log('ERROR', `cannot load config/jobs.json: ${error.name}: ${error.message}`);
    process.exit(1);
  }
  for (const job of jobs) log('INFO', `scheduled ${job.name} every ${job.everyMs}ms`);
  let tick = 0;
  setInterval(() => {
    tick += 1;
    const due = jobs.filter(job => job.everyMs > 0 && (tick * 1000) % job.everyMs < 1000).map(job => job.name);
    log('INFO', due.length ? `tick ${tick}: ran ${due.join(', ')}` : `tick ${tick}: idle`);
  }, 1000);
}
