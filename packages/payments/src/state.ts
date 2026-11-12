// Payment states and the only transitions allowed between them. Every change goes
// through transition(), and every transition is written to the audit log by the store.
// Anything that does not fit a legal transition goes to review_required. It is never
// dropped and never silently accepted.

export type PaymentStatus =
  | 'initiated'
  | 'authorised'
  | 'captured'
  | 'failed'
  | 'expired'
  | 'released'
  | 'refund_pending'
  | 'refunded'
  | 'review_required';

const TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  initiated: ['authorised', 'captured', 'failed', 'expired', 'review_required'],
  authorised: ['captured', 'released', 'expired', 'review_required'],
  captured: ['refund_pending', 'review_required'],
  refund_pending: ['refunded', 'captured', 'review_required'],
  refunded: [],
  failed: [],
  expired: ['review_required'],
  released: [],
  review_required: ['authorised', 'captured', 'released', 'refunded', 'failed'],
};

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
export const LIVE_STATUSES: readonly PaymentStatus[] = ['initiated', 'authorised', 'captured', 'refund_pending', 'review_required'];
