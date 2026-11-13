// What the customer sees. Tickets are shown only when the status says they were issued, and
// the wording comes from status.ts so no screen can claim more than the supplier has said.

import type { TicketDocument, HoldPassenger } from '../../flights/src/supplier.ts';
import { customerStatus, type CustomerStatusView } from './status.ts';
import type { FulfilmentRecord } from './store.ts';
import { passengersFor, ticketsFor, type PassengerView, type TicketView } from './privacy.ts';

export interface CustomerScreen {
  readonly status: CustomerStatusView;
  readonly bookingReference: string | null; // shown only once the airline has issued one
  readonly passengers: readonly PassengerView[];
  readonly tickets: readonly TicketView[];
  readonly lockedMessage: string | null;
}

export function customerScreen(record: FulfilmentRecord): CustomerScreen {
  const status = customerStatus(record.status);
  const docs: readonly TicketDocument[] = status.showTickets ? record.documents : [];
  return {
    status,
    bookingReference: record.bookingReference,
    passengers: passengersFor('customer', record.passengers as readonly HoldPassenger[]),
    tickets: ticketsFor('customer', docs),
    lockedMessage: record.lockedReason,
  };
}
