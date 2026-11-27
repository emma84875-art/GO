// Payment states and the only transitions allowed between them. Every change goes
// through transition(), and every transition is written to the audit log by the store.
// Anything that does not fit a legal transition goes to review_required. It is never
// dropped and never silently accepted.

// Every payment state. The database check constraint is generated from this list (scripts/generate-booking-lifecycle-sql.mjs).
export const PAYMENT_STATUSES = [
  'initiated',
  'authorised',
  'capture_requested',
  'captured',
  'failed',
  'expired',
  'released',
  'refund_pending',
  'refunded',
  'review_required',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

// Capture is two steps. The backend asks the provider to capture (authorised -> capture_requested). Only the
// provider's verified result moves the payment to captured (or back to authorised if the capture was declined).
// captured is reachable only from capture_requested, so no path to captured skips a capture request, and a person in
// review must move the payment back to authorised before a new request can be made.
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  initiated: ['authorised', 'failed', 'expired', 'review_required'],
  authorised: ['capture_requested', 'released', 'expired', 'review_required'],
  capture_requested: ['captured', 'authorised', 'review_required'],
  captured: ['refund_pending', 'review_required'],
  refund_pending: ['refunded', 'captured', 'review_required'],
  refunded: [],
  failed: [],
  expired: ['review_required'],
  released: [],
  review_required: ['authorised', 'released', 'refunded', 'failed'],
};

// The only status a backend capture request may set. Every other change comes from a verified provider result.
export const CAPTURE_REQUEST_TARGET: PaymentStatus = 'capture_requested';

const TRANSITIONS = PAYMENT_TRANSITIONS;

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(from: PaymentStatus, to: PaymentStatus): PaymentStatus {
  if (!canTransition(from, to)) {
    throw new RangeError(`Illegal payment transition ${from} -> ${to}`);
  }
  return to;
}

// States that still hold, or may still hold, a customer's money. A booking may have at
// most one of these at a time. This is the duplicate-charge guard.
export const LIVE_STATUSES: readonly PaymentStatus[] = ['initiated', 'authorised', 'capture_requested', 'captured', 'refund_pending', 'review_required'];
