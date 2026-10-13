// Simulated upstream: publishes payment webhook events to queue/inbox.jsonl.
import { appendFileSync, mkdirSync } from 'node:fs';

const cycle = [
  { type: 'charge', order_id: 1001, amount: '25.00' },
  { type: 'refund', order_id: 998, amount: '12.50', reason: 'damaged' },
  { type: 'charge', order_id: 1002, amount: '7.25' },
  { type: 'refund', order_id: 977, amount: '1,299.00', reason: 'returned' },
  { type: 'charge', order_id: 1003, amount: '1349.99' },
  { type: 'refund', order_id: 1001, amount: '5.00', reason: 'goodwill' },
  { type: 'charge', order_id: 1004, amount: '64.10' },
  { type: 'refund', order_id: 950, amount: '2,450.75', reason: 'returned' },
];

mkdirSync('queue', { recursive: true });
let sequence = 0;
setInterval(() => {
  const event = { id: `evt_${sequence}`, ...cycle[sequence % cycle.length] };
  appendFileSync('queue/inbox.jsonl', `${JSON.stringify(event)}\n`);
  console.log(`${new Date().toISOString()} INFO producer: published ${event.id} (${event.type})`);
  sequence += 1;
}, 600);
