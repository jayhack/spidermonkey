// Normalizes payment webhook events from the queue into ledger records.
export function parseEvent(line) {
  const event = JSON.parse(line);
  switch (event.type) {
    case 'charge':
      return { type: 'charge', orderId: String(event.order_id), amountCents: toCents(event.amount) };
    default:
      throw new Error(`unsupported event type ${event.type}`);
  }
}

function toCents(amount) {
  const cents = Math.round(Number(amount) * 100);
  if (!Number.isInteger(cents)) throw new Error(`invalid amount ${amount}`);
  return cents;
}
