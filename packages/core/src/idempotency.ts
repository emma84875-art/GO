// Idempotency keys for money-moving and supplier-calling operations.
// The same logical operation always produces the same key, so retries cannot
// create a second payment, capture, or supplier order.

export type IdempotentOperation =
  | 'supplier_hold'
  | 'supplier_order'
  | 'supplier_ticket'
  | 'payment_authorise'
  | 'payment_capture'
  | 'payment_release'
  | 'refund';

const OPERATIONS: readonly IdempotentOperation[] = [
  'supplier_hold',
  'supplier_order',
  'supplier_ticket',
  'payment_authorise',
  'payment_capture',
  'payment_release',
  'refund',
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function idempotencyKey(bookingId: string, operation: IdempotentOperation, attempt = 1): string {
  if (!UUID_PATTERN.test(bookingId)) throw new TypeError('bookingId must be a UUID');
  if (!OPERATIONS.includes(operation)) throw new TypeError(`Unknown operation: ${operation}`);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new RangeError('attempt must be a positive integer');
  return `booking:${bookingId.toLowerCase()}:${operation}:${attempt}`;
}

// The same operation with a different attempt is a deliberate retry. Operators
// must give a reason for each new attempt (enforced in the admin dashboard, later).
export function nextAttempt(current: number): number {
  if (!Number.isSafeInteger(current) || current < 1) throw new RangeError('attempt must be a positive integer');
  return current + 1;
}
