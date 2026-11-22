// Shared inputs for the customer and operations views.
//
// The fulfilment record does not carry an owner, so the caller supplies it (from bookings.user_id
// in the database). The portal never reads an owner from the record itself.

import type { FulfilmentRecord, HistoryEntry } from '../../fulfilment/src/store.ts';

export interface PortalBooking {
  readonly ownerUserId: string;
  readonly record: FulfilmentRecord;
  readonly history: readonly HistoryEntry[];
}
