// Fulfilment states and the only legal moves between them. A booking is "confirmed" or
// "ticketed" only when the supplier has said so. Nothing in this file infers success.

export type FulfilmentStatus =
  | 'held' // supplier hold placed, no payment authorised yet
  | 'authorised' // customer payment authorised (not captured)
  | 'order_pending' // supplier order exists, awaiting payment to the airline
  | 'ticketing_pending' // paid, documents not yet visible
  | 'ticketed' // every seat-occupying passenger has a document; capture not yet done
  | 'partially_fulfilled' // some documents issued, others missing: a person decides
  | 'confirmed' // ticketed AND payment captured
  | 'order_unknown' // order request had no clear answer: locked until reconciled
  | 'ticketing_unknown' // payment request to supplier had no clear answer: locked
  | 'failed' // no order can be completed; authorisation released or under review
  | 'expired' // hold lapsed before an order was created
  | 'cancellation_pending'
  | 'cancelled'
  | 'refund_pending'
  | 'refunded';

const MOVES: Readonly<Record<FulfilmentStatus, readonly FulfilmentStatus[]>> = {
  held: ['authorised', 'expired', 'failed'],
  authorised: ['order_pending', 'order_unknown', 'failed', 'expired'],
  order_pending: ['ticketing_pending', 'ticketed', 'partially_fulfilled', 'ticketing_unknown', 'failed', 'cancellation_pending'],
  ticketing_pending: ['ticketed', 'partially_fulfilled', 'ticketing_unknown', 'failed', 'cancellation_pending'],
  ticketed: ['confirmed', 'cancellation_pending'],
  partially_fulfilled: ['ticketed', 'cancellation_pending'],
  confirmed: ['cancellation_pending'],
  order_unknown: ['order_pending', 'failed'],
  ticketing_unknown: ['ticketing_pending', 'ticketed', 'partially_fulfilled', 'failed'],
  failed: [],
  expired: [],
  cancellation_pending: ['cancelled', 'confirmed', 'ticketed'],
  cancelled: ['refund_pending', 'refunded'],
  refund_pending: ['refunded'],
  refunded: [],
};

export function canMove(from: FulfilmentStatus, to: FulfilmentStatus): boolean {
  return MOVES[from].includes(to);
}

export function move(from: FulfilmentStatus, to: FulfilmentStatus): FulfilmentStatus {
  if (!canMove(from, to)) throw new RangeError(`Illegal fulfilment move ${from} -> ${to}`);
  return to;
}

// States in which the system must not place a new supplier order or ticket request.
export const LOCKED: readonly FulfilmentStatus[] = ['order_unknown', 'ticketing_unknown'];

// Customer-facing wording. Each state maps to exactly one message, and the message for a
// state that is not yet confirmed never claims confirmation.
export interface CustomerStatusView {
  readonly headline: string;
  readonly detail: string;
  readonly showTickets: boolean;
  readonly tone: 'success' | 'progress' | 'action' | 'failure';
}

export function customerStatus(status: FulfilmentStatus): CustomerStatusView {
  switch (status) {
    case 'confirmed':
      return { headline: 'Booking confirmed', detail: 'Your tickets have been issued by the airline.', showTickets: true, tone: 'success' };
    case 'ticketed':
      return { headline: 'Tickets issued, finalising payment', detail: 'Your tickets are issued. We are completing the payment step.', showTickets: true, tone: 'progress' };
    case 'held':
    case 'authorised':
    case 'order_pending':
    case 'ticketing_pending':
      return { headline: 'Booking in progress', detail: 'Your booking is not yet confirmed. Do not book again.', showTickets: false, tone: 'progress' };
    case 'order_unknown':
    case 'ticketing_unknown':
      return { headline: 'We are checking your booking', detail: 'We are confirming the status with the airline. Please do not book again. We will contact you.', showTickets: false, tone: 'action' };
    case 'partially_fulfilled':
      return { headline: 'Some tickets are not yet issued', detail: 'Our team is handling the remaining tickets. Your booking is not fully confirmed.', showTickets: false, tone: 'action' };
    case 'failed':
      return { headline: 'Your booking could not be completed', detail: 'No ticket has been issued. Any payment authorisation will be released or refunded.', showTickets: false, tone: 'failure' };
    case 'expired':
      return { headline: 'Your fare has expired', detail: 'The reserved fare ended before the booking was completed. No payment was taken.', showTickets: false, tone: 'failure' };
    case 'cancellation_pending':
      return { headline: 'Cancellation in progress', detail: 'We are cancelling your booking with the airline.', showTickets: false, tone: 'action' };
    case 'cancelled':
      return { headline: 'Booking cancelled', detail: 'Your booking has been cancelled. A refund will follow.', showTickets: false, tone: 'action' };
    case 'refund_pending':
      return { headline: 'Refund in progress', detail: 'Your refund has been requested.', showTickets: false, tone: 'progress' };
    case 'refunded':
      return { headline: 'Refunded', detail: 'Your refund has been completed.', showTickets: false, tone: 'success' };
  }
}
