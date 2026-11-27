// Supplier order and ticket fulfilment, under the Phase 19.0 decision record (docs/24).
//   authorise payment -> revalidate fare and hold -> partner order -> partner issues tickets
//   -> GO verifies the tickets -> capture the customer's payment -> confirm. Partner remittance is tracked separately and does not gate confirmation.
//
// GO never pays a supplier for ticket issuance. If a supplier says payment is due from GO, the booking
// is blocked and nothing is paid. Ticket verification and partner remittance are not built yet (Phase 19.x), so
// no booking in this module reaches 'captured' or 'confirmed' from supplier documents alone.
//
// Rules that hold throughout:
//   - Every supplier write records a 'sent' operation first. A 'sent' operation with no result
//     is an unknown outcome. It is never re-sent automatically.
//   - An unknown outcome locks the booking (order_unknown or ticketing_unknown). A person must
//     reconcile it with the supplier.
//   - A definitive failure before an order exists releases the customer's authorisation.
//   - 'tickets_issued' is set only from supplier documents. 'verified' is set only by GO's own check of those
//     documents. 'confirmed' is set only after verification and capture. Nothing is inferred.

import type { FlightOrderOperations, FlightSupplier, HoldPassenger, OrderSnapshot, TicketDocument } from '../../flights/src/supplier.ts';
import { SupplierUnavailableError } from '../../flights/src/supplier.ts';
import type { PaymentProvider } from '../../payments/src/provider.ts';
import type { PaymentStore } from '../../payments/src/store.ts';
import { captureAfterFulfilment, releaseAfterSupplierFailure, refund } from '../../payments/src/payment-flow.ts';
import type { FulfilmentRecord, FulfilmentStore } from './store.ts';
import { authorise, type Actor } from '../../auth/src/actor.ts';

// Internal steps (release, refund on cancellation, capture) run as the fulfilment service. The
// caller's own permission is checked once, at the public entry point, with authorise().
const SERVICE: Actor = Object.freeze({ kind: 'system', service: 'fulfilment' } as const);
import type { FulfilmentStatus } from './status.ts';

export type OrderSupplier = FlightSupplier & Partial<FlightOrderOperations>;

export interface FulfilmentDeps {
  readonly supplier: OrderSupplier;
  readonly payments: PaymentProvider;
  readonly payStore: PaymentStore;
  readonly store: FulfilmentStore;
  readonly productionEnabled?: boolean; // owner gate: production ticketing stays off until approved
}

// A seat-occupying passenger is any passenger who is not an infant. Infant documents are not
// required by this rule. Confirm with the supplier before relying on it for infants.
export function seatPassengerIndexes(passengers: readonly HoldPassenger[]): number[] {
  return passengers.flatMap((p, index) => (p.type === 'infant' ? [] : [index]));
}

// Derives the fulfilment status from what the supplier says. Pure function: no inference.
export function statusFromSnapshot(snapshot: OrderSnapshot, passengers: readonly HoldPassenger[]): FulfilmentStatus {
  if (snapshot.cancelled) return 'cancellation_pending';
  // Awaiting payment from GO is not a state GO may act on. The booking stays at partner_ordered.
  if (snapshot.awaitingPayment) return 'partner_ordered';
  const seats = seatPassengerIndexes(passengers);
  const covered = new Set(snapshot.documents.map((d) => d.passengerIndex));
  const coveredSeats = seats.filter((index) => covered.has(index));
  if (seats.length > 0 && coveredSeats.length === seats.length) return 'tickets_issued';
  if (coveredSeats.length > 0) return 'partially_fulfilled';
  return 'ticketing_pending';
}

export function snapshotDocuments(snapshot: OrderSnapshot): readonly TicketDocument[] {
  return snapshot.documents;
}

// Step 1 for an authorised booking: revalidate, create the supplier order, then pay the airline.
export async function placeOrder(deps: FulfilmentDeps, actor: Actor, bookingId: string, nowUtc: string): Promise<FulfilmentRecord> {
  authorise(actor, 'fulfilment.order');
  const rec = requireRecord(deps, bookingId);
  if (rec.status !== "authorised") return rec;
  if (deps.supplier.mode === "production" && deps.productionEnabled !== true) {
    return deps.store.patch(bookingId, { blockedReason: "Production ticketing is disabled." });
  }
  // Passport collection is not enabled. An offer the supplier says needs identity documents is not
  // ordered, so no passenger is sent to an airline without the data the airline requires.
  if (rec.offer.identityDocumentRequirement === 'required') {
    return deps.store.patch(bookingId, { blockedReason: 'This airline requires identity documents. Document collection is not enabled, so no order is placed.' });
  }
  const intent = deps.payStore.getIntent(rec.intentId);
  if (!intent || intent.status !== 'authorised') return rec;

  // Hold window: if the hold has lapsed, no order can be made. Release the authorisation.
  if (Date.parse(rec.holdExpiresAtUtc) <= Date.parse(nowUtc)) {
    await release(deps, rec, nowUtc);
    return deps.store.transition(bookingId, 'expired', 'hold_lapsed_before_order', nowUtc);
  }

  // A prior 'sent' or 'done' order operation means the order must not be created again.
  const orderKey = `booking:${bookingId}:supplier_order:1`;
  const prior = deps.store.operation(orderKey);
  if (prior?.state === 'sent') {
    return deps.store.transition(bookingId, 'order_unknown', 'order_outcome_unknown', nowUtc, {
      lockedReason: 'A previous order request has no recorded result. Reconcile with the supplier before any retry.',
    });
  }
  if (prior?.state === 'done' && prior.orderId) {
    return readOrder(deps, deps.store.patch(bookingId, { orderId: prior.orderId }), nowUtc);
  }

  if (!deps.supplier.createOrder || !deps.supplier.priceOffer) {
    await release(deps, rec, nowUtc);
    return deps.store.transition(bookingId, 'failed', 'supplier_cannot_order', nowUtc, { blockedReason: 'Supplier does not support orders.' });
  }

  // Revalidate the fare immediately before creating the order.
  try {
    const fresh = await deps.supplier.priceOffer(rec.offer, nowUtc);
    if (fresh.supplierPrice.amountMinor !== rec.offer.supplierPrice.amountMinor) {
      await release(deps, rec, nowUtc);
      return deps.store.transition(bookingId, 'failed', 'fare_changed_before_order', nowUtc, { blockedReason: 'The fare changed before the order was made.' });
    }
  } catch (error) {
    if (error instanceof SupplierUnavailableError && error.reason === 'offer_expired') {
      await release(deps, rec, nowUtc);
      return deps.store.transition(bookingId, 'expired', 'fare_expired_before_order', nowUtc);
    }
    if (error instanceof SupplierUnavailableError) {
      // Revalidation failed without an order. Nothing was created, so the authorisation can be released.
      await release(deps, rec, nowUtc);
      return deps.store.transition(bookingId, 'failed', 'revalidation_failed', nowUtc, { blockedReason: error.message });
    }
    throw error;
  }

  deps.store.recordOperation({ key: orderKey, state: 'sent', orderId: null });
  try {
    const created = await deps.supplier.createOrder(rec.offer, rec.passengers, orderKey, nowUtc);
    deps.store.recordOperation({ key: orderKey, state: 'done', orderId: created.orderId });
    const withOrder = deps.store.patch(bookingId, {
      orderId: created.orderId,
      bookingReference: created.snapshot.bookingReference,
      documents: snapshotDocuments(created.snapshot),
    });
    deps.store.transition(bookingId, 'partner_ordered', 'order_created', nowUtc, {
      orderId: withOrder.orderId,
      bookingReference: withOrder.bookingReference,
    });
    return readOrder(deps, deps.store.get(bookingId) as FulfilmentRecord, nowUtc);
  } catch (error) {
    if (error instanceof SupplierUnavailableError && (error.reason === 'timeout' || error.reason === 'provider_error')) {
      // The order may exist. Do not release, do not retry. Lock for reconciliation.
      return deps.store.transition(bookingId, 'order_unknown', 'order_request_failed_unclear', nowUtc, {
        lockedReason: 'The order request had no clear answer. The supplier may hold an order. Reconcile before any retry.',
      });
    }
    if (error instanceof SupplierUnavailableError) {
      // Definitive refusal: no order was created.
      await release(deps, rec, nowUtc);
      return deps.store.transition(bookingId, 'failed', `order_refused_${error.reason}`, nowUtc, { blockedReason: error.message });
    }
    throw error;
  }
}

// Step 2: read the order back from the supplier. GO does not pay the supplier. If the supplier says payment
// is due from GO, the booking is blocked and nothing is paid (Phase 19.0, D3).
async function readOrder(deps: FulfilmentDeps, rec: FulfilmentRecord, nowUtc: string): Promise<FulfilmentRecord> {
  const orderId = rec.orderId as string;
  let snapshot: OrderSnapshot;
  try {
    snapshot = await deps.supplier.getOrder!(orderId);
  } catch {
    return rec; // read failed: keep the status and try again later. Nothing is assumed.
  }
  if (snapshot.awaitingPayment) {
    return deps.store.patch(rec.bookingId, {
      blockedReason: 'The supplier asks GO to pay for ticket issuance. GO does not fund supplier tickets, so nothing was paid (docs/24, D3).',
    });
  }
  return finishFromSnapshot(deps, rec, snapshot, nowUtc);
}

function finishFromSnapshot(deps: FulfilmentDeps, rec: FulfilmentRecord, snapshot: OrderSnapshot, nowUtc: string): FulfilmentRecord {
  const documents = snapshotDocuments(snapshot);
  const next = statusFromSnapshot(snapshot, rec.passengers);
  const patched = deps.store.patch(rec.bookingId, { documents, bookingReference: snapshot.bookingReference ?? rec.bookingReference });
  if (next === patched.status) return patched;
  const from = patched.status;
  if (!deps.store.canMove(from, next)) return patched; // never force a move the table does not allow
  return deps.store.transition(rec.bookingId, next, `supplier_reports_${next}`, nowUtc);
}

// Polls a booking whose tickets were not yet visible, or whose payment outcome was unknown.
export async function pollTicketing(deps: FulfilmentDeps, actor: Actor, bookingId: string, nowUtc: string): Promise<FulfilmentRecord> {
  authorise(actor, 'fulfilment.poll');
  const rec = requireRecord(deps, bookingId);
  if (!['partner_ordered', 'ticketing_pending', 'ticketing_unknown', 'partially_fulfilled'].includes(rec.status) || !rec.orderId) return rec;
  if (rec.status === 'ticketing_unknown') {
    // Clear the lock only when the supplier reports the order without a pending payment from GO.
    const snapshot = await deps.supplier.getOrder!(rec.orderId);
    if (!snapshot.awaitingPayment) return finishFromSnapshot(deps, rec, snapshot, nowUtc);
    return rec;
  }
  return readOrder(deps, rec, nowUtc);
}

// Capture only after GO has verified the tickets. Supplier-reported documents are not enough.
// Every condition is checked again by the payments module.
export async function captureIfVerified(deps: FulfilmentDeps, actor: Actor, bookingId: string, nowUtc: string): Promise<FulfilmentRecord> {
  authorise(actor, 'payment.capture');
  const rec = requireRecord(deps, bookingId);
  if (rec.status !== 'verified') return rec;
  const result = await captureAfterFulfilment(deps.payStore, SERVICE, deps.payments, rec.intentId, 'verified', rec.totalMinor, rec.currency as 'NGN', nowUtc);
  if (result.status === 'captured') {
    return deps.store.transition(bookingId, 'captured', 'payment_captured_after_verification', nowUtc);
  }
  const reason = result.status === 'blocked' ? result.reasons.join(' ') : result.reason;
  return deps.store.patch(bookingId, { blockedReason: reason });
}

// Cancellation: cancel with the supplier, then refund the customer if money was captured,
// or release the authorisation if it was not.
export async function cancelBooking(deps: FulfilmentDeps, actor: Actor, bookingId: string, nowUtc: string): Promise<FulfilmentRecord> {
  authorise(actor, 'fulfilment.cancel');
  const rec = requireRecord(deps, bookingId);
  // Owner gate, as for ticketing: no supplier cancellation in production until approved.
  if (deps.supplier.mode === 'production' && deps.productionEnabled !== true) {
    return deps.store.patch(bookingId, { blockedReason: 'Production cancellation is disabled.' });
  }
  if (!['partner_ordered', 'ticketing_pending', 'partially_fulfilled', 'tickets_issued', 'verified', 'captured', 'confirmed'].includes(rec.status) || !rec.orderId) {
    throw new RangeError(`Cannot cancel a booking in ${rec.status}`);
  }
  const pending = deps.store.transition(bookingId, 'cancellation_pending', 'cancellation_requested', nowUtc);
  if (!deps.supplier.cancelOrder) {
    return pending; // stays pending: cancellation with the supplier is not supported, so a person must act
  }
  const key = `booking:${bookingId}:supplier_cancel:1`;
  deps.store.recordOperation({ key, state: 'sent', orderId: rec.orderId });
  try {
    await deps.supplier.cancelOrder(rec.orderId, key);
    deps.store.recordOperation({ key, state: 'done', orderId: rec.orderId });
  } catch {
    return pending; // unknown: stay in cancellation_pending. Retry uses the same key.
  }
  const cancelled = deps.store.transition(bookingId, 'cancelled', 'supplier_cancelled', nowUtc);
  const intent = deps.payStore.getIntent(rec.intentId);
  if (intent?.status === 'captured' && intent.capturedMinor > 0) {
    const r = await refund(deps.payStore, SERVICE, deps.payments, rec.intentId, intent.capturedMinor, nowUtc);
    if (r.status === 'refunded') return deps.store.transition(bookingId, 'refunded', 'refund_completed', nowUtc);
    return deps.store.transition(bookingId, 'refund_pending', 'refund_requested', nowUtc);
  }
  await release(deps, cancelled, nowUtc);
  return cancelled;
}

async function release(deps: FulfilmentDeps, rec: FulfilmentRecord, nowUtc: string): Promise<void> {
  await releaseAfterSupplierFailure(deps.payStore, SERVICE, deps.payments, rec.intentId, nowUtc);
}

function requireRecord(deps: FulfilmentDeps, bookingId: string): FulfilmentRecord {
  const rec = deps.store.get(bookingId);
  if (!rec) throw new RangeError('Unknown booking');
  return rec;
}
