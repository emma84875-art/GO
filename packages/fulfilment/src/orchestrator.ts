// Supplier order and ticket fulfilment, under the Phase 19.0 decision record (docs/24).
//   authorise payment -> revalidate fare and hold -> partner order -> partner issues tickets
//   -> GO verifies the tickets -> capture the customer's payment -> confirm. Partner remittance is tracked separately and does not gate confirmation.
//
// GO never pays a supplier for ticket issuance. If a supplier says payment is due from GO, the booking
// is blocked and nothing is paid. Ticket verification and partner remittance are not built yet (Phase 19.x), so
// no booking in this module reaches 'captured' or 'confirmed' from supplier documents alone.
//
// Rules that hold throughout:
//   - Every supplier write begins an operation in the persistent operation ledger (docs/26) first. The ledger decides
//     whether the write may be sent, and its result is recorded there. An operation with a lapsed lease and no result
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
import { randomUUID } from 'node:crypto';
import { requestFingerprint, type OperationLedger } from '../../operations/src/ledger.ts';

// Internal steps (release, refund on cancellation, capture) run as the fulfilment service. The
// caller's own permission is checked once, at the public entry point, with authorise().
const SERVICE: Actor = Object.freeze({ kind: 'system', service: 'fulfilment' } as const);
import type { FulfilmentStatus } from './status.ts';

// How long an external call may run before its operation counts as interrupted (docs/26, section 8: a guess).
const EXTERNAL_LEASE_SECONDS = 300;

export type OrderSupplier = FlightSupplier & Partial<FlightOrderOperations>;

export interface FulfilmentDeps {
  readonly supplier: OrderSupplier;
  readonly payments: PaymentProvider;
  readonly payStore: PaymentStore;
  readonly store: FulfilmentStore;
  // The durable operation ledger. Every supplier order, supplier cancel and capture request is begun here first.
  readonly ledger: OperationLedger;
  readonly externalLeaseSeconds?: number;
  readonly productionEnabled?: boolean; // owner gate: production ticketing stays off until approved
}

function leaseSeconds(deps: FulfilmentDeps): number {
  return deps.externalLeaseSeconds ?? EXTERNAL_LEASE_SECONDS;
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

  // The ledger, not in-memory state, decides whether an order was already requested. A restart cannot forget it.
  const orderKey = `booking:${bookingId}:supplier_order:1`;
  const owner = randomUUID();
  const begun = await deps.ledger.begin({
    operationType: 'supplier.order',
    idempotencyKey: orderKey,
    subjectRef: bookingId,
    fingerprint: requestFingerprint({ bookingId, intentId: rec.intentId, totalMinor: rec.totalMinor, passengers: rec.passengers.length }),
    actorLabel: 'backend:fulfilment',
    correlationId: orderKey,
    owner,
    leaseSeconds: leaseSeconds(deps),
  });
  if (begun.decision === 'already_succeeded') {
    return readOrder(deps, deps.store.patch(bookingId, { orderId: begun.resultRef }), nowUtc);
  }
  if (begun.decision === 'needs_reconciliation') {
    return deps.store.transition(bookingId, 'order_unknown', 'order_outcome_unknown', nowUtc, {
      lockedReason: 'A previous order request has no recorded result. Reconcile with the supplier before any retry.',
    });
  }
  if (begun.decision === 'in_progress') {
    return rec; // another process holds the live request. Nothing is sent from here.
  }
  if (begun.decision !== 'started') {
    return deps.store.patch(bookingId, { blockedReason: `Order not sent: the operation ledger reports ${begun.decision}.` });
  }

  if (!deps.supplier.createOrder || !deps.supplier.priceOffer) {
    await deps.ledger.complete(begun.operationId, owner, { outcome: 'failed_terminal', failureCode: 'supplier_cannot_order' }, orderKey);
    await release(deps, rec, nowUtc);
    return deps.store.transition(bookingId, 'failed', 'supplier_cannot_order', nowUtc, { blockedReason: 'Supplier does not support orders.' });
  }

  // Revalidate the fare immediately before creating the order.
  try {
    const fresh = await deps.supplier.priceOffer(rec.offer, nowUtc);
    if (fresh.supplierPrice.amountMinor !== rec.offer.supplierPrice.amountMinor) {
      await deps.ledger.complete(begun.operationId, owner, { outcome: 'failed_retryable', failureCode: 'fare_changed_before_order' }, orderKey);
      await release(deps, rec, nowUtc);
      return deps.store.transition(bookingId, 'failed', 'fare_changed_before_order', nowUtc, { blockedReason: 'The fare changed before the order was made.' });
    }
  } catch (error) {
    if (error instanceof SupplierUnavailableError && error.reason === 'offer_expired') {
      await deps.ledger.complete(begun.operationId, owner, { outcome: 'failed_retryable', failureCode: 'offer_expired' }, orderKey);
      await release(deps, rec, nowUtc);
      return deps.store.transition(bookingId, 'expired', 'fare_expired_before_order', nowUtc);
    }
    if (error instanceof SupplierUnavailableError) {
      // Revalidation failed without an order. Nothing was created, so the authorisation can be released.
      await deps.ledger.complete(begun.operationId, owner, { outcome: 'failed_retryable', failureCode: 'revalidation_failed' }, orderKey);
      await release(deps, rec, nowUtc);
      return deps.store.transition(bookingId, 'failed', 'revalidation_failed', nowUtc, { blockedReason: error.message });
    }
    await deps.ledger.complete(begun.operationId, owner, { outcome: 'failed_retryable', failureCode: 'revalidation_error' }, orderKey);
    throw error;
  }

  // The request is recorded as begun in the ledger before the supplier is called. If the process stops here, the lease
  // lapses and the ledger marks the order unknown. It is never sent again on a guess.
  let created: Awaited<ReturnType<NonNullable<OrderSupplier['createOrder']>>>;
  try {
    created = await deps.supplier.createOrder(rec.offer, rec.passengers, orderKey, nowUtc);
  } catch (error) {
    if (error instanceof SupplierUnavailableError && (error.reason === 'timeout' || error.reason === 'provider_error')) {
      // The order may exist. Do not release, do not retry. Lock for reconciliation.
      await deps.ledger.complete(begun.operationId, owner, { outcome: 'unknown', failureCode: error.reason }, orderKey);
      return deps.store.transition(bookingId, 'order_unknown', 'order_request_failed_unclear', nowUtc, {
        lockedReason: 'The order request had no clear answer. The supplier may hold an order. Reconcile before any retry.',
      });
    }
    if (error instanceof SupplierUnavailableError) {
      // Definitive refusal: no order was created.
      await deps.ledger.complete(begun.operationId, owner, { outcome: 'failed_terminal', failureCode: error.reason }, orderKey);
      await release(deps, rec, nowUtc);
      return deps.store.transition(bookingId, 'failed', `order_refused_${error.reason}`, nowUtc, { blockedReason: error.message });
    }
    await deps.ledger.complete(begun.operationId, owner, { outcome: 'unknown', failureCode: 'unexpected_error' }, orderKey);
    throw error;
  }
  await deps.ledger.complete(begun.operationId, owner, { outcome: 'succeeded', resultRef: created.orderId }, orderKey);
  {
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
  const intent = deps.payStore.getIntent(rec.intentId);
  if (!intent) return deps.store.patch(bookingId, { blockedReason: 'Payment intent not found. Nothing was captured.' });

  // The ledger decides whether the provider may be asked to capture. The key is the intent's capture key, the same one
  // the provider receives. A retry after a sent request never sends it again.
  const key = `${intent.reference}:capture:1`;
  const owner = randomUUID();
  const begun = await deps.ledger.begin({
    operationType: 'payment.capture_request',
    idempotencyKey: key,
    subjectRef: intent.id,
    fingerprint: requestFingerprint({ intentId: intent.id, amountMinor: rec.totalMinor, currency: rec.currency }),
    actorLabel: 'backend:fulfilment',
    correlationId: key,
    owner,
    leaseSeconds: leaseSeconds(deps),
  });
  if (begun.decision === 'already_succeeded') {
    return deps.store.patch(bookingId, { blockedReason: 'A capture was already requested. The provider status must be checked; nothing is sent again.' });
  }
  if (begun.decision !== 'started') {
    return deps.store.patch(bookingId, { blockedReason: `Capture not sent: the operation ledger reports ${begun.decision}. A person checks the provider.` });
  }

  const result = await captureAfterFulfilment(deps.payStore, SERVICE, deps.payments, rec.intentId, 'verified', rec.totalMinor, rec.currency as 'NGN', nowUtc);
  if (result.status === 'captured') {
    await deps.ledger.complete(begun.operationId, owner, { outcome: 'succeeded', resultRef: intent.providerRef ?? intent.id }, key);
    return deps.store.transition(bookingId, 'captured', 'payment_captured_after_verification', nowUtc);
  }
  if (result.status === 'blocked') {
    // Blocked before the provider was called, so nothing was sent and one new attempt is allowed.
    await deps.ledger.complete(begun.operationId, owner, { outcome: 'failed_retryable', failureCode: 'capture_blocked' }, key);
    return deps.store.patch(bookingId, { blockedReason: result.reasons.join(' ') });
  }
  // The provider was asked and its outcome is not confirmed. It is recorded as unknown and is never sent again automatically.
  await deps.ledger.complete(begun.operationId, owner, { outcome: 'unknown', failureCode: 'capture_unknown' }, key);
  return deps.store.patch(bookingId, { blockedReason: result.reason });
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
  const owner = randomUUID();
  const begun = await deps.ledger.begin({
    operationType: 'supplier.cancel',
    idempotencyKey: key,
    subjectRef: bookingId,
    fingerprint: requestFingerprint({ bookingId, orderId: rec.orderId }),
    actorLabel: 'backend:fulfilment',
    correlationId: key,
    owner,
    leaseSeconds: leaseSeconds(deps),
  });
  if (begun.decision === 'started') {
    try {
      await deps.supplier.cancelOrder(rec.orderId, key);
    } catch {
      // Unknown: the cancel may have been accepted. Stay in cancellation_pending. A retry uses the same key and is refused
      // by the ledger until the outcome is reconciled.
      await deps.ledger.complete(begun.operationId, owner, { outcome: 'unknown', failureCode: 'cancel_unknown' }, key);
      return pending;
    }
    await deps.ledger.complete(begun.operationId, owner, { outcome: 'succeeded', resultRef: rec.orderId }, key);
  } else if (begun.decision !== 'already_succeeded') {
    return pending; // in_progress, needs_reconciliation or refused: nothing is sent from here
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
