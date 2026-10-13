// Normalizes payment webhook events from the queue into ledger records.
export function parseEvent(line) {
  const event = JSON.parse(line);
  switch (event.type) {
    case 'charge':
      return { type: 'charge', orderId: String(event.order_id), amountCents: toCents(event.amount) };
    case 'refund':
      return { type: 'refund', orderId: String(event.order_id), amountCents: toCents(event.amount), reason: event.reason };
    default:
      throw new Error(`unsupported event type ${event.type}`);
  }
}

function toCents(amount) {
  // Upstream systems format large amounts with thousands separators ("1,299.00").
  const cents = Math.round(Number(String(amount).replaceAll(',', '')) * 100);
  if (!Number.isInteger(cents)) throw new Error(`invalid amount ${amount}`);
  return cents;
}
