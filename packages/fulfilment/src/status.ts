// Fulfilment status. The vocabulary, the transitions and the stage rules are defined once, in
// packages/core/src/booking-lifecycle.ts, and mirrored in the database. This module adds the
// customer-facing wording only. A booking is 'confirmed' only after GO verifies the tickets and the customer's payment is captured, and tickets
// are shown to the customer only after GO has verified them.

import {
  BOOKING_STATES,
  LOCKED_STATES,
  canTransition,
  transition,
  ticketsVisible,
  type BookingState,
} from '../../core/src/booking-lifecycle.ts';

export type FulfilmentStatus = BookingState;

export const FULFILMENT_STATUSES: readonly FulfilmentStatus[] = BOOKING_STATES;

export function canMove(from: FulfilmentStatus, to: FulfilmentStatus): boolean {
  return canTransition(from, to);
}

export function move(from: FulfilmentStatus, to: FulfilmentStatus): FulfilmentStatus {
  if (!canMove(from, to)) throw new RangeError(`Illegal fulfilment move ${from} -> ${to}`);
  return transition(from, to);
}

// States in which the system must not place a new supplier order or ticket request.
export const LOCKED: readonly FulfilmentStatus[] = LOCKED_STATES;

// Customer-facing wording. Each state maps to exactly one message. A state that is not yet
// confirmed never claims confirmation.
export interface CustomerStatusView {
  readonly headline: string;
  readonly detail: string;
  readonly showTickets: boolean;
  readonly tone: 'success' | 'progress' | 'action' | 'failure';
}

export function customerStatus(status: FulfilmentStatus): CustomerStatusView {
  const showTickets = ticketsVisible(status);
  switch (status) {
    case 'draft':
      return { headline: 'Not yet booked', detail: 'Your booking has not started.', showTickets, tone: 'progress' };
    case 'quoted':
      return { headline: 'Booking in progress', detail: 'Your fare is held. No payment has been taken.', showTickets, tone: 'progress' };
    case 'authorised':
    case 'partner_ordered':
    case 'ticketing_pending':
      return { headline: 'Booking in progress', detail: 'Your booking is not yet confirmed. Do not book again.', showTickets, tone: 'progress' };
    case 'order_unknown':
    case 'ticketing_unknown':
      return { headline: 'We are checking your booking', detail: 'We are confirming the status with the airline. Please do not book again. We will contact you.', showTickets, tone: 'action' };
    case 'tickets_issued':
      return { headline: 'Tickets pending verification', detail: 'The airline has issued your tickets. They are not valid for travel until we have verified them. You will see them here once verification succeeds.', showTickets, tone: 'progress' };
    case 'partially_fulfilled':
      return { headline: 'Some tickets are not yet issued', detail: 'Our team is handling the remaining tickets. Your booking is not fully confirmed.', showTickets, tone: 'action' };
    case 'verified':
    case 'captured':
      return { headline: 'Tickets verified, finalising', detail: 'Your tickets are verified. We are completing the final steps.', showTickets, tone: 'progress' };
    case 'confirmed':
      return { headline: 'Booking confirmed', detail: 'Your tickets are confirmed.', showTickets, tone: 'success' };
    case 'verification_failed':
    case 'review_required':
      return { headline: 'We are checking your booking', detail: 'We are checking the tickets against your booking. We will contact you.', showTickets, tone: 'action' };
    case 'failed':
      return { headline: 'Your booking could not be completed', detail: 'No ticket has been issued. Any payment authorisation will be released or refunded.', showTickets, tone: 'failure' };
    case 'expired':
      return { headline: 'Your fare has expired', detail: 'The reserved fare ended before the booking was completed. No payment was taken.', showTickets, tone: 'failure' };
    case 'cancellation_pending':
      return { headline: 'Cancellation in progress', detail: 'We are cancelling your booking with the airline.', showTickets, tone: 'action' };
    case 'cancelled':
      return { headline: 'Booking cancelled', detail: 'Your booking has been cancelled. A refund will follow.', showTickets, tone: 'action' };
    case 'refund_pending':
      return { headline: 'Refund in progress', detail: 'Your refund has been requested.', showTickets, tone: 'progress' };
    case 'refunded':
      return { headline: 'Refunded', detail: 'Your refund has been completed.', showTickets, tone: 'success' };
  }
}
