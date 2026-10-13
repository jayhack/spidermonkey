import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEvent } from '../src/parse-event.js';

test('normalizes charges', () => {
  assert.deepEqual(parseEvent('{"type":"charge","order_id":42,"amount":"19.99"}'), { type: 'charge', orderId: '42', amountCents: 1999 });
});

test('rejects unknown event types', () => {
  assert.throws(() => parseEvent('{"type":"dispute","order_id":1}'), /unsupported event type/);
});
