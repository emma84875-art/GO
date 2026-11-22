// Verified system states. A notification that says "tickets issued" or "payment confirmed" is
// built only from these checks, never from a caller's claim.
//
// Ticket confirmation: the fulfilment record must show ticketed or confirmed, and the supplier
// documents must be present. Those documents come from the supplier's order snapshot, so they
// reflect actual issuance.
// Payment confirmation: the payment intent must be captured. Capture only happens after tickets
// are issued (docs/12, docs/13).

import type { FulfilmentRecord } from '../../fulfilment/src/store.ts';
import type { PaymentStatus } from '../../payments/src/state.ts';

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function ticketsVerified(record: FulfilmentRecord): Verdict {
  if (record.status !== 'ticketed' && record.status !== 'confirmed') {
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
