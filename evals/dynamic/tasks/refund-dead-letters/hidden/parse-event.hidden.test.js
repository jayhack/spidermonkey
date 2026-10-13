import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEvent } from '../src/parse-event.js';

// The events service/producer.js publishes.
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

const expected = {
  charge: event => ({ type: 'charge', orderId: String(event.order_id), amountCents: Math.round(Number(event.amount.replaceAll(',', '')) * 100) }),
  refund: event => ({ type: 'refund', orderId: String(event.order_id), amountCents: Math.round(Number(event.amount.replaceAll(',', '')) * 100), reason: event.reason }),
};

test('every event the live producer publishes is normalized', () => {
  for (const event of cycle) assert.deepEqual(parseEvent(JSON.stringify({ id: 'evt_x', ...event })), expected[event.type](event), JSON.stringify(event));
});

test('the documented refund example', () => {
  assert.deepEqual(parseEvent('{"type":"refund","order_id":123,"amount":"12.50","reason":"damaged"}'), { type: 'refund', orderId: '123', amountCents: 1250, reason: 'damaged' });
});

test('charges and unknown types keep their behavior', () => {
  assert.deepEqual(parseEvent('{"type":"charge","order_id":42,"amount":"19.99"}'), { type: 'charge', orderId: '42', amountCents: 1999 });
  assert.throws(() => parseEvent('{"type":"dispute","order_id":1}'), /unsupported event type/);
});
