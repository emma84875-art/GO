// Reservation status and ticket status are tracked separately. The UI must never
// present a booking as ticketed unless the ticket status is 'ticketed', which is
// only set after the supplier returns ticket numbers for every passenger.

export type ReservationStatus =
  | 'draft'
  | 'quoted'
  | 'pending_payment'
  | 'payment_confirmed'
  | 'reservation_pending'
  | 'reservation_confirmed'
  | 'reservation_failed';

export type TicketStatus = 'not_issued' | 'ticketing_pending' | 'ticketed' | 'ticketing_failed';

const RESERVATION_TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  draft: ['quoted'],
  quoted: ['pending_payment'],
  pending_payment: ['payment_confirmed'],
  payment_confirmed: ['reservation_pending'],
  reservation_pending: ['reservation_confirmed', 'reservation_failed'],
  reservation_confirmed: [],
  reservation_failed: [],
};

const TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  not_issued: ['ticketing_pending'],
  ticketing_pending: ['ticketed', 'ticketing_failed'],
  ticketed: [],
  ticketing_failed: [],
};

export function canTransitionReservation(from: ReservationStatus, to: ReservationStatus): boolean {
  return RESERVATION_TRANSITIONS[from].includes(to);
}

export function canTransitionTicket(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from].includes(to);
}

export function transitionReservation(from: ReservationStatus, to: ReservationStatus): ReservationStatus {
  if (!canTransitionReservation(from, to)) {
    throw new Error(`Invalid reservation transition: ${from} -> ${to}`);
  }
  return to;
}

export function transitionTicket(
  reservation: ReservationStatus,
  from: TicketStatus,
  to: TicketStatus,
): TicketStatus {
  if (!canTransitionTicket(from, to)) {
    throw new Error(`Invalid ticket transition: ${from} -> ${to}`);
  }
  // A ticket can only be issued against a confirmed reservation.
  if (to === 'ticketing_pending' && reservation !== 'reservation_confirmed') {
    throw new Error(`Cannot start ticketing while reservation is ${reservation}`);
  }
  return to;
}

// Customer-facing label. This is the only place the status wording is decided,
// so "Ticketed" can never be shown without a supplier-issued ticket.
export function customerStatusLabel(reservation: ReservationStatus, ticket: TicketStatus): string {
  if (ticket === 'ticketed') {
    return 'Ticketed';
  }
  if (ticket === 'ticketing_failed') {
    return 'Ticketing failed: refund in progress';
  }
  if (ticket === 'ticketing_pending') {
    return 'Payment received: ticketing in progress';
  }
  switch (reservation) {
    case 'draft':
    case 'quoted':
      return 'Not yet booked';
    case 'pending_payment':
      return 'Awaiting payment';
    case 'payment_confirmed':
    case 'reservation_pending':
      return 'Reservation pending: not yet ticketed';
    case 'reservation_confirmed':
      return 'Reservation confirmed: ticketing not yet started';
    case 'reservation_failed':
      return 'Reservation failed';
  }
}
