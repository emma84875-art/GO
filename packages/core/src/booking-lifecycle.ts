// The single authoritative booking and fulfilment state model (Phase 19.1, decision record docs/24).
//
// The database (supabase/migrations/20261126000000_booking_lifecycle.sql) enforces the same table
// and the same stage rules. A unit test compares the two, so they cannot drift apart silently.
//
// Money-safety rules encoded here:
//   - Customer payment is authorised first and captured last (Option A only).
//   - GO never funds supplier ticket issuance. The ticketing partner carries that funding exposure.
//   - Confirmation needs GO's own independent verification of every ticket and a successful customer capture.
//   - Partner remittance is a separate financial obligation. It is tracked on its own record, with its own
//     statuses, and it never gates the booking. See REMITTANCE_STATUSES and MONEY_FLOWS below.
//   - Customers can read a valid ticket only after GO's independent verification has succeeded.

export const BOOKING_STATES = [
  'draft',
  'quoted',
  'authorised',
  'order_unknown',
  'partner_ordered',
  'ticketing_pending',
  'ticketing_unknown',
  'tickets_issued',
  'partially_fulfilled',
  'verified',
  'verification_failed',
  'captured',
  'confirmed',
  'review_required',
  'failed',
  'expired',
  'cancellation_pending',
  'cancelled',
  'refund_pending',
  'refunded',
] as const;

export type BookingState = (typeof BOOKING_STATES)[number];

// Each milestone is recorded once, with a timestamp, and never cleared.
export const MILESTONES = [
  'quoted_at',
  'authorised_at',
  'partner_order_confirmed_at',
  'tickets_issued_at',
  'tickets_verified_at',
  'captured_at',
  'confirmed_at',
] as const;

export type Milestone = (typeof MILESTONES)[number];

export type MilestoneRecord = Partial<Record<Milestone, string | null>>;

// Stage rank of each state. A state at rank N requires the milestones of ranks 1 to N.
// Rank 0 means no milestone is required. Exception states take the rank of the last stage the
// booking must have reached to be in that state (for example, a locked order needs authorised_at).
export const STAGE_OF: Readonly<Record<BookingState, number>> = {
  draft: 0,
  quoted: 1,
  authorised: 2,
  order_unknown: 2,
  partner_ordered: 3,
  ticketing_pending: 3,
  ticketing_unknown: 3,
  tickets_issued: 4,
  partially_fulfilled: 4,
  verification_failed: 4,
  verified: 5,
  captured: 6,
  confirmed: 7,
  review_required: 0,
  failed: 0,
  expired: 0,
  cancellation_pending: 0,
  cancelled: 0,
  refund_pending: 0,
  refunded: 0,
};

// Milestone that each stage rank requires (stage 1 needs quoted_at, and so on).
export const STAGE_MILESTONE: Readonly<Record<number, Milestone>> = {
  1: 'quoted_at',
  2: 'authorised_at',
  3: 'partner_order_confirmed_at',
  4: 'tickets_issued_at',
  5: 'tickets_verified_at',
  6: 'captured_at',
  7: 'confirmed_at',
};

export const BOOKING_TRANSITIONS: Readonly<Record<BookingState, readonly BookingState[]>> = {
  draft: ['quoted'],
  quoted: ['authorised', 'expired', 'failed'],
  authorised: ['partner_ordered', 'order_unknown', 'expired', 'failed'],
  order_unknown: ['partner_ordered', 'failed'],
  partner_ordered: ['ticketing_pending', 'tickets_issued', 'partially_fulfilled', 'ticketing_unknown', 'failed', 'cancellation_pending'],
  ticketing_pending: ['tickets_issued', 'partially_fulfilled', 'ticketing_unknown', 'failed', 'cancellation_pending'],
  ticketing_unknown: ['ticketing_pending', 'tickets_issued', 'partially_fulfilled', 'failed'],
  tickets_issued: ['verified', 'verification_failed', 'cancellation_pending'],
  partially_fulfilled: ['tickets_issued', 'verification_failed', 'cancellation_pending'],
  verified: ['captured', 'review_required', 'cancellation_pending'],
  verification_failed: ['verified', 'cancellation_pending', 'failed'],
  captured: ['confirmed', 'review_required', 'cancellation_pending'],
  confirmed: ['cancellation_pending'],
  review_required: ['verified', 'captured', 'confirmed', 'cancellation_pending', 'refund_pending', 'failed'],
  cancellation_pending: ['cancelled', 'confirmed', 'captured', 'verified', 'tickets_issued'],
  cancelled: ['refund_pending', 'refunded'],
  refund_pending: ['refunded'],
  failed: [],
  expired: [],
  refunded: [],
};

// States in which no supplier order or ticket request may be sent automatically. A person reconciles them.
export const LOCKED_STATES: readonly BookingState[] = ['order_unknown', 'ticketing_unknown'];

// States in which a valid ticket may be shown to the customer. Only GO's independent verification
// (tickets.verified_at) makes a ticket valid, and only these states allow it to be shown. Before that the
// customer sees a pending-verification status and no ticket. The database applies the same rule to reads.
export const TICKETS_VISIBLE_STATES: readonly BookingState[] = ['verified', 'captured', 'confirmed'];

// Remittance to the ticketing partner is tracked on its own record (partner_remittances), not in the booking
// state. Its statuses are explicit, and no remittance status changes the booking.
export const REMITTANCE_STATUSES = ['not_required', 'pending', 'paid', 'failed', 'under_review'] as const;

export type RemittanceStatus = (typeof REMITTANCE_STATUSES)[number];

// Permitted changes of remittance status. 'not_required' and 'paid' are terminal.
export const REMITTANCE_TRANSITIONS: Readonly<Record<RemittanceStatus, readonly RemittanceStatus[]>> = {
  not_required: [],
  pending: ['paid', 'failed', 'under_review'],
  paid: [],
  failed: ['pending', 'under_review'],
  under_review: ['pending', 'paid', 'failed'],
};

// The four money flows, kept apart on purpose (docs/24, section 3A).
//   1. Customer payment capture: the payment provider takes the authorised amount. Recorded on the payment
//      (payments.status = captured) and gates the booking's 'captured' state.
//   2. Provider settlement: the payment provider pays the captured funds into GO's bank. Recorded on the
//      payment (payments.provider_settled_at). It is reconciled separately and never gates a booking.
//   3. Partner remittance: GO pays the ticketing partner an amount set by the partner agreement, if the agreement
//      requires one. Recorded on partner_remittances, with its own status. It never gates a booking, and it is
//      never described as GO financing ticket issuance.
//   4. Confirmation: a booking-state event that depends only on flows 1 and the ticket verification. It needs no
//      provider settlement and no partner remittance.
export const MONEY_FLOWS = {
  customerCapture: 'payments.status = captured; booking state captured',
  providerSettlement: 'payments.provider_settled_at; reconciled separately; never gates a booking',
  partnerRemittance: 'partner_remittances row with its own status; never gates a booking; follows the partner agreement',
} as const;

// The only milestones that confirmation depends on. Neither provider settlement nor partner remittance is one of them.
export const CONFIRMATION_PREREQUISITES: readonly Milestone[] = ['tickets_verified_at', 'captured_at'];

export function canTransition(from: BookingState, to: BookingState): boolean {
  return BOOKING_TRANSITIONS[from].includes(to);
}

export function transition(from: BookingState, to: BookingState): BookingState {
  if (!canTransition(from, to)) throw new RangeError(`Illegal booking transition ${from} -> ${to}`);
  return to;
}

export function canRemittanceTransition(from: RemittanceStatus, to: RemittanceStatus): boolean {
  return REMITTANCE_TRANSITIONS[from].includes(to);
}

export function stageOf(state: BookingState): number {
  return STAGE_OF[state];
}

// Returns the list of problems. An empty list means the milestones agree with the state.
export function milestoneProblems(state: BookingState, milestones: MilestoneRecord): string[] {
  const problems: string[] = [];
  const stage = STAGE_OF[state];
  for (let rank = 1; rank <= stage; rank += 1) {
    const field = STAGE_MILESTONE[rank];
    if (!milestones[field]) problems.push(`${state} requires ${field}`);
  }
  // Ordering: a later milestone cannot exist without the earlier ones.
  for (let rank = 2; rank <= 7; rank += 1) {
    const field = STAGE_MILESTONE[rank];
    const earlier = STAGE_MILESTONE[rank - 1];
    if (milestones[field] && !milestones[earlier]) problems.push(`${field} is set without ${earlier}`);
  }
  return problems;
}

// GO captures a payment only for a booking that GO has verified.
export function canCapture(state: BookingState, milestones: MilestoneRecord): boolean {
  return state === 'verified' && Boolean(milestones.tickets_verified_at);
}

// GO confirms a booking only from 'captured', and only when every prerequisite milestone is recorded.
// Provider settlement and partner remittance are not checked.
export function canConfirm(state: BookingState, milestones: MilestoneRecord): boolean {
  return state === 'captured' && CONFIRMATION_PREREQUISITES.every((m) => Boolean(milestones[m]));
}

// Funding is fixed: GO never pays a supplier for ticket issuance.
export const FUNDING_MODEL = 'partner_funded' as const;

export function assertPartnerFunded(fundingModel: string): void {
  if (fundingModel !== FUNDING_MODEL) {
    throw new RangeError('GO does not fund supplier ticket issuance. Only the partner-funded model is permitted (docs/24, D3).');
  }
}

export function isLocked(state: BookingState): boolean {
  return LOCKED_STATES.includes(state);
}

export function ticketsVisible(state: BookingState): boolean {
  return TICKETS_VISIBLE_STATES.includes(state);
}
