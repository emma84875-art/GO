// Refund records, eligibility, amounts and the status history.
//
// Three refund sources are kept separate, because each has its own owner and evidence:
//   - supplier: the airline or its agent refunds the fare. Eligible only when the supplier has
//     confirmed it. Amount limit: the booking total.
//   - payment_provider: the payment provider returns captured money. Eligible only when the payment
//     is captured, the amount is still refundable, and the provider's refund capability is
//     'supported'. Amount limit: captured minus already refunded.
//   - go: GO returns its own fee. Amount limit: the GO fee. The fee policy is still undecided and
//     is zero, so no GO refund can be made today.
//
// A refund is never shown as promised. Eligibility is 'unconfirmed' until the relevant party
// confirms it. Execution is a separate, gated step in service.ts.

export const REFUND_SOURCES = ['supplier', 'payment_provider', 'go'] as const;
export type RefundSource = (typeof REFUND_SOURCES)[number];

export const REFUND_STATUSES = [
  'requested',
  'pending_approval',
  'approved',
  'rejected',
  'execution_pending',
  'completed',
  'failed',
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export type Eligibility = 'not_checked' | 'eligible' | 'ineligible' | 'unconfirmed';

export const REASON_CODES = ['cancelled_by_customer', 'schedule_change', 'duplicate_payment', 'service_failure', 'other'] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

const TRANSITIONS: Readonly<Record<RefundStatus, readonly RefundStatus[]>> = {
  requested: ['pending_approval', 'rejected'],
  pending_approval: ['pending_approval', 'approved', 'rejected'],
  approved: ['execution_pending'],
  rejected: [],
  execution_pending: ['completed', 'failed'],
  completed: [],
  failed: ['execution_pending'],
};

export function canMoveRefund(from: RefundStatus, to: RefundStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function moveRefund(from: RefundStatus, to: RefundStatus): RefundStatus {
  if (!canMoveRefund(from, to)) throw new RangeError(`Illegal refund transition ${from} -> ${to}`);
  return to;
}

export interface RefundStep {
  readonly at: string;
  readonly actorId: string;
  readonly from: RefundStatus | null;
  readonly to: RefundStatus;
  readonly note: string | null;
}

export interface RefundRecord {
  readonly id: string;
  readonly bookingId: string;
  readonly requestedBy: string;
  readonly requestedAmountMinor: number;
  readonly currency: string;
  readonly reasonCode: ReasonCode;
  readonly reasonText: string | null;
  readonly createdAt: string;
  readonly status: RefundStatus;
  readonly source: RefundSource | null;
  readonly amountMinor: number | null; // the amount checked for the source
  readonly eligibility: Eligibility;
  readonly eligibilityNote: string | null;
  readonly decidedBy: string | null;
  readonly executionRef: string | null;
  readonly history: readonly RefundStep[];
}

// Facts the caller gathers from the booking, payment and supplier records. Nothing here is
// assumed: a missing or unverified fact makes the refund unconfirmed, not eligible.
export interface RefundFacts {
  readonly bookingTotalMinor: number;
  readonly supplierRefundConfirmed: boolean;
  readonly payment: {
    readonly status: 'initiated' | 'authorised' | 'captured' | 'failed' | 'expired' | 'released' | 'refund_pending' | 'refunded' | 'review_required';
    readonly capturedMinor: number;
    readonly refundedMinor: number;
    readonly refundCapability: 'supported' | 'unconfirmed' | 'not_supported';
  } | null;
  readonly goFeeMinor: number;
}

export function maxRefundable(source: RefundSource, facts: RefundFacts): number {
  switch (source) {
    case 'supplier':
      return facts.bookingTotalMinor;
    case 'payment_provider':
      return facts.payment ? Math.max(0, facts.payment.capturedMinor - facts.payment.refundedMinor) : 0;
    case 'go':
      return Math.max(0, facts.goFeeMinor);
  }
}

// Throws RangeError with a short code in the message for any invalid amount.
export function validateRefundAmount(amountMinor: number, max: number): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new RangeError('invalid_amount');
  if (amountMinor > max) throw new RangeError('amount_exceeds_limit');
}

export interface EligibilityResult {
  readonly eligibility: Eligibility;
  readonly note: string;
}

// Decides whether the refund can be confirmed for this source and amount. It never returns
// 'eligible' without a confirmed fact.
export function evaluateEligibility(source: RefundSource, amountMinor: number, facts: RefundFacts): EligibilityResult {
  const max = maxRefundable(source, facts);
  if (source === 'supplier') {
    if (!facts.supplierRefundConfirmed) return { eligibility: 'unconfirmed', note: 'The airline has not confirmed a refund.' };
    return { eligibility: 'eligible', note: 'The airline has confirmed a refund.' };
  }
  if (source === 'payment_provider') {
    if (!facts.payment) return { eligibility: 'ineligible', note: 'No payment is recorded for this booking.' };
    if (facts.payment.status !== 'captured') return { eligibility: 'ineligible', note: 'The payment is not captured, so there is nothing to refund.' };
    if (facts.payment.refundCapability !== 'supported') {
      return { eligibility: 'unconfirmed', note: 'The payment provider has not confirmed refunds for this account.' };
    }
    if (amountMinor > max) return { eligibility: 'ineligible', note: 'The amount is more than the payment still refundable.' };
    return { eligibility: 'eligible', note: 'The payment provider supports refunds and the amount is refundable.' };
  }
  // GO fee refund
  if (max <= 0) return { eligibility: 'ineligible', note: 'GO has no fee to refund under the current fee policy.' };
  if (amountMinor > max) return { eligibility: 'ineligible', note: 'The amount is more than the GO fee.' };
  return { eligibility: 'eligible', note: 'The amount is within the GO fee.' };
}

// Customer-facing wording. It never says a refund is promised or has been paid before it is.
export function customerRefundWording(status: RefundStatus, eligibility: Eligibility): string {
  switch (status) {
    case 'requested':
      return 'We have received your refund request and are checking it. We have not confirmed any amount yet.';
    case 'pending_approval':
      return eligibility === 'eligible'
        ? 'Your refund is being reviewed. It has not been approved yet.'
        : 'We are waiting for confirmation from the airline or payment provider before we can decide. No refund is promised yet.';
    case 'approved':
      return 'Your refund has been approved and is being processed. The money has not yet been returned.';
    case 'execution_pending':
      return 'Your refund is being processed. The money has not yet been returned.';
    case 'completed':
      return 'Your refund has been completed.';
    case 'rejected':
      return 'Your refund request was not approved. Contact support if you have questions.';
    case 'failed':
      return 'We could not complete your refund yet. Our team is looking at it. No money has been returned.';
  }
}
