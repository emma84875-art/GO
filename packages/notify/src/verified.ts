// Verified system states. A notification that says "tickets issued" or "payment confirmed" is
// built only from these checks, never from a caller's claim.
//
// Ticket confirmation: the record must be at a state where GO has verified the tickets (or later), and
// supplier documents must be present. A supplier's documents alone are not enough (docs/24).
// Payment confirmation: the payment intent must be captured. Capture only happens after tickets
// are issued (docs/12, docs/13).

import type { FulfilmentRecord } from '../../fulfilment/src/store.ts';
import { ticketsVisible } from '../../core/src/booking-lifecycle.ts';
import type { PaymentStatus } from '../../payments/src/state.ts';

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function ticketsVerified(record: FulfilmentRecord): Verdict {
  if (!ticketsVisible(record.status)) {
    return { ok: false, reason: `status_${record.status}` };
  }
  if (record.documents.length === 0) return { ok: false, reason: 'no_supplier_documents' };
  return { ok: true };
}

export function paymentCaptured(status: PaymentStatus): Verdict {
  return status === 'captured' ? { ok: true } : { ok: false, reason: `payment_${status}` };
}

export function paymentFailed(status: PaymentStatus): Verdict {
  return status === 'failed' || status === 'expired' ? { ok: true } : { ok: false, reason: `payment_${status}` };
}
