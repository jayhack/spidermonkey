// Queue consumer: parses new events from queue/inbox.jsonl with src/parse-event.js.
// Parsed records go to queue/processed.jsonl; failures go to queue/dead-letter.jsonl.
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { parseEvent } from '../src/parse-event.js';

const INBOX = 'queue/inbox.jsonl';
const log = (level, message) => console.log(`${new Date().toISOString()} ${level} consumer: ${message}`);
mkdirSync('queue', { recursive: true });

// Only events published after this consumer started are its responsibility.
let offset = existsSync(INBOX) ? statSync(INBOX).size : 0;
let processed = 0;
let deadLettered = 0;

function poll() {
  if (!existsSync(INBOX)) return;
  const size = statSync(INBOX).size;
  if (size <= offset) return;
  const buffer = Buffer.alloc(size - offset);
  const fd = openSync(INBOX, 'r');
  readSync(fd, buffer, 0, buffer.length, offset);
  closeSync(fd);
  const text = buffer.toString('utf8');
  const complete = text.lastIndexOf('\n') + 1;
  offset += Buffer.byteLength(text.slice(0, complete));
  for (const line of text.slice(0, complete).split('\n').filter(Boolean)) {
    try {
      appendFileSync('queue/processed.jsonl', `${JSON.stringify(parseEvent(line))}\n`);
      processed += 1;
    } catch (error) {
      appendFileSync('queue/dead-letter.jsonl', `${JSON.stringify({ at: new Date().toISOString(), error: error.message, event: JSON.parse(line) })}\n`);
      deadLettered += 1;
    }
  }
}

log('INFO', 'consumer started');
setInterval(poll, 250);
setInterval(() => log('INFO', `processed=${processed} dead_lettered=${deadLettered}`), 5000);
