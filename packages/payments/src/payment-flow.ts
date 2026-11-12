// Connects payments to a valid booking. Nothing starts unless the booking has a live
// supplier hold, the fare is revalidated, the amount matches the booking summary, and the
// provider has confirmed authorisation. Each step either succeeds or returns a reason.

import type { Offer, FlightSupplier } from '../../flights/src/supplier.ts';
import { SupplierUnavailableError } from '../../flights/src/supplier.ts';
import { money } from '../../core/src/money.ts';
import type { PaymentIntent } from './intent.ts';
import type { PaymentProvider } from './provider.ts';
import type { PaymentStore } from './store.ts';
import { liveIntentFor } from './intent.ts';
import { captureDecision, type FulfilmentState, refundableMinor } from './money-safety.ts';
import { moveIntent } from './transitions.ts';

export const INTENT_WINDOW_MINUTES = 30;

export interface PaymentBooking {
  readonly bookingId: string;
  readonly holdId: string;
  readonly holdExpiresAtUtc: string;
  readonly offer: Offer;
  readonly totalMinor: number; // from the booking summary, the amount the customer sees
  readonly currency: 'NGN' | 'USD' | 'GBP' | 'EUR';
  readonly customerEmail: string;
}

export interface Gate {
  readonly productionEnabled: boolean; // owner switch; false until approval
}

export type StartOutcome =
  | { readonly status: 'initiated'; readonly intentId: string; readonly redirectUrl: string }
  | { readonly status: 'duplicate_attempt'; readonly intentId: string }
  | {
      readonly status: 'blocked';
      readonly reason:
        | 'production_disabled'
        | 'authorisation_not_confirmed'
        | 'hold_missing'
        | 'hold_expired'
        | 'fare_expired'
        | 'fare_changed'
        | 'amount_mismatch'
        | 'supplier_unavailable';
      readonly detail: string;
    };

export async function startPayment(
  store: PaymentStore,
  provider: PaymentProvider,
  supplier: FlightSupplier,
  booking: PaymentBooking,
  gate: Gate,
  nowUtc: string,
): Promise<StartOutcome> {
  // 1. Duplicate guard: one live payment per booking. Return the existing one, never a new charge.
  const existing = liveIntentFor(store.allIntents(), booking.bookingId);
  if (existing) return { status: 'duplicate_attempt', intentId: existing.id };

  // 2. Owner gate. Production stays off until the owner approves it.
  if (provider.mode === 'production' && !gate.productionEnabled) {
    return { status: 'blocked', reason: 'production_disabled', detail: 'Production payments are disabled.' };
  }

  // 3. Money-safety: no authorisation without written or documented provider support.
  if (provider.capabilities.authorisation !== 'supported') {
    return {
      status: 'blocked',
      reason: 'authorisation_not_confirmed',
      detail: `Provider ${provider.name} has not confirmed authorisation. Payment is not started.`,
    };
  }

  // 4. A live supplier hold is required before any money is requested.
  if (!booking.holdId) return { status: 'blocked', reason: 'hold_missing', detail: 'No supplier hold exists for this booking.' };
  if (Date.parse(booking.holdExpiresAtUtc) <= Date.parse(nowUtc)) {
    return { status: 'blocked', reason: 'hold_expired', detail: 'The supplier hold has expired.' };
  }

  // 5. Revalidate the fare with the supplier before asking for money.
  let fresh: Offer;
  try {
    if (!supplier.priceOffer) {
      return { status: "blocked", reason: "supplier_unavailable", detail: "Supplier cannot revalidate fares, so payment is not started." };
    }
    fresh = await supplier.priceOffer(booking.offer, nowUtc);
  } catch (error) {
    if (error instanceof SupplierUnavailableError && error.reason === 'offer_expired') {
      return { status: 'blocked', reason: 'fare_expired', detail: 'The fare is no longer valid.' };
    }
    if (error instanceof SupplierUnavailableError) {
      return { status: 'blocked', reason: 'supplier_unavailable', detail: error.message };
    }
    throw error;
  }
  if (fresh.supplierPrice.amountMinor !== booking.offer.supplierPrice.amountMinor) {
    return { status: 'blocked', reason: 'fare_changed', detail: 'The fare changed. The customer must accept the new price first.' };
  }

  // 6. The amount to charge must equal the summary the customer accepted.
  if (fresh.displayPrice.currency !== booking.currency) {
    return { status: 'blocked', reason: 'amount_mismatch', detail: 'Currency differs from the booking summary.' };
  }
  if (fresh.displayPrice.amountMinor !== booking.totalMinor) {
    return { status: 'blocked', reason: 'amount_mismatch', detail: 'Amount differs from the booking summary.' };
  }

  // 7. Intent expires no later than the hold, so authorisation never outlives seat availability.
  const windowEnd = new Date(Date.parse(nowUtc) + INTENT_WINDOW_MINUTES * 60_000);
  const holdEnd = new Date(booking.holdExpiresAtUtc);
  const expiresAt = (windowEnd < holdEnd ? windowEnd : holdEnd).toISOString().replace('.000Z', 'Z');

  const reference = `booking:${booking.bookingId}:payment_authorise:1`;
  const amount = money(booking.totalMinor, booking.currency);
  const result = await provider.initiate({
    reference,
    amount,
    customerEmail: booking.customerEmail,
    expiresAtUtc: expiresAt,
    mode: 'authorise',
  });

  const intent: PaymentIntent = {
    id: `pi_${reference.replace(/[^a-z0-9]+/gi, '_')}`,
    bookingId: booking.bookingId,
    provider: provider.name,
    amount,
    status: 'initiated',
    providerRef: result.providerRef,
    reference,
    createdAtUtc: nowUtc,
    expiresAtUtc: expiresAt,
    capturedMinor: 0,
    refundedMinor: 0,
  };
  store.saveIntent(intent);
  store.append({ at: nowUtc, intentId: intent.id, event: 'initiated', from: null, to: 'initiated', detail: `booking ${booking.bookingId}` });
  return { status: 'initiated', intentId: intent.id, redirectUrl: result.redirectUrl };
}

export type CaptureOutcome =
  | { readonly status: 'captured'; readonly intentId: string }
  | { readonly status: 'blocked'; readonly reasons: readonly string[] }
  | { readonly status: 'review_required'; readonly intentId: string; readonly reason: string };

// Capture is attempted only when fulfilment is confirmed and every money-safety condition holds.
export async function captureAfterFulfilment(
  store: PaymentStore,
  provider: PaymentProvider,
  intentId: string,
  fulfilment: FulfilmentState,
  bookingTotalMinor: number,
  bookingCurrency: 'NGN' | 'USD' | 'GBP' | 'EUR',
  nowUtc: string,
): Promise<CaptureOutcome> {
  const intent = store.getIntent(intentId);
  if (!intent) return { status: 'blocked', reasons: ['Unknown intent.'] };

  const decision = captureDecision(intent, {
    fulfilment,
    bookingTotalMinor,
    bookingCurrency,
    capabilities: provider.capabilities,
    nowUtc,
  });
  if (!decision.allowed || !provider.capture || !intent.providerRef) {
    return { status: 'blocked', reasons: decision.allowed ? ['Provider capture is not available.'] : decision.reasons };
  }

  try {
    const truth = await provider.capture(intent.providerRef, intent.amount, `${intent.reference}:capture:1`);
    if (truth.state !== 'captured') {
      const updated = moveIntent(store, intent, 'review_required', 'capture_unexpected', nowUtc, `Capture returned ${truth.state}`);
      return { status: 'review_required', intentId: updated.id, reason: `capture returned ${truth.state}` };
    }
    const updated = moveIntent(store, intent, 'captured', 'capture', nowUtc, 'Captured after confirmed fulfilment', {
      capturedMinor: intent.amount.amountMinor,
    });
    return { status: 'captured', intentId: updated.id };
  } catch {
    // Outcome unknown. Never assume the capture failed or succeeded; a person checks the provider.
    const updated = moveIntent(store, intent, 'review_required', 'capture_unknown', nowUtc, 'Capture request had no clear result');
    return { status: 'review_required', intentId: updated.id, reason: 'capture outcome unknown' };
  }
}

// Supplier booking failed after authorisation: release the hold so the customer is not charged.
export async function releaseAfterSupplierFailure(
  store: PaymentStore,
  provider: PaymentProvider,
  intentId: string,
  nowUtc: string,
): Promise<{ status: 'released' | 'review_required'; intentId: string; reason?: string }> {
  const intent = store.getIntent(intentId);
  if (!intent || intent.status !== 'authorised' || !intent.providerRef) {
    return { status: 'review_required', intentId, reason: 'intent is not in authorised state' };
  }
  if (!provider.release) {
    const updated = moveIntent(store, intent, 'review_required', 'release_unsupported', nowUtc, 'Provider cannot release; manual action needed');
    return { status: 'review_required', intentId: updated.id, reason: 'provider cannot release' };
  }
  try {
    const truth = await provider.release(intent.providerRef, `${intent.reference}:release:1`);
    if (truth.state !== 'released') {
      const updated = moveIntent(store, intent, 'review_required', 'release_unexpected', nowUtc, `Release returned ${truth.state}`);
      return { status: 'review_required', intentId: updated.id, reason: `release returned ${truth.state}` };
    }
    const updated = moveIntent(store, intent, 'released', 'release', nowUtc, 'Released after supplier failure');
    return { status: 'released', intentId: updated.id };
  } catch {
    const updated = moveIntent(store, intent, 'review_required', 'release_unknown', nowUtc, 'Release request had no clear result');
    return { status: 'review_required', intentId: updated.id, reason: 'release outcome unknown' };
  }
}

export type RefundOutcome =
  | { readonly status: 'refunded' | 'partially_refunded'; readonly intentId: string }
  | { readonly status: 'blocked'; readonly reason: string }
  | { readonly status: 'review_required'; readonly intentId: string; readonly reason: string };

export async function refund(
  store: PaymentStore,
  provider: PaymentProvider,
  intentId: string,
  amountMinor: number,
  nowUtc: string,
): Promise<RefundOutcome> {
  const intent = store.getIntent(intentId);
  if (!intent) return { status: 'blocked', reason: 'Unknown intent.' };
  if (intent.status !== 'captured') return { status: 'blocked', reason: `Only captured payments can be refunded; this is ${intent.status}.` };
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return { status: 'blocked', reason: 'Refund amount must be a positive whole number.' };
  if (amountMinor > refundableMinor(intent)) return { status: 'blocked', reason: 'Refund exceeds the amount still refundable.' };
  if (!provider.refund || !intent.providerRef || provider.capabilities.refund !== 'supported') {
    return { status: 'blocked', reason: 'Provider refunds are not confirmed.' };
  }

  const refundKey = `${intent.reference}:refund:${intent.refundedMinor + amountMinor}`;
  const pending = moveIntent(store, intent, 'refund_pending', 'refund_requested', nowUtc, `Refund ${amountMinor} requested`);
  try {
    const truth = await provider.refund(intent.providerRef, money(amountMinor, intent.amount.currency), refundKey);
    if (truth.state !== 'refunded') {
      const updated = moveIntent(store, pending, 'review_required', 'refund_unexpected', nowUtc, `Refund returned ${truth.state}`);
      return { status: 'review_required', intentId: updated.id, reason: `refund returned ${truth.state}` };
    }
    const newRefunded = pending.refundedMinor + amountMinor;
    const fullyRefunded = newRefunded === pending.capturedMinor;
    const updated = moveIntent(
      store,
      pending,
      fullyRefunded ? 'refunded' : 'captured',
      'refund_completed',
      nowUtc,
      `Refunded ${amountMinor}, total refunded ${newRefunded}`,
      { refundedMinor: newRefunded },
    );
    return { status: fullyRefunded ? 'refunded' : 'partially_refunded', intentId: updated.id };
  } catch {
    const updated = moveIntent(store, pending, 'review_required', 'refund_unknown', nowUtc, 'Refund request had no clear result');
    return { status: 'review_required', intentId: updated.id, reason: 'refund outcome unknown' };
  }
}

// Expiry sweep. An initiated intent past its window is expired and can no longer be paid.
// An authorised hold past its window cannot be captured. It must be released, so it goes to
// review_required rather than being left in limbo.
export function expireStaleIntents(store: PaymentStore, nowUtc: string): readonly string[] {
  const changed: string[] = [];
  for (const intent of store.allIntents()) {
    if (Date.parse(intent.expiresAtUtc) > Date.parse(nowUtc)) continue;
    if (intent.status === 'initiated') {
      moveIntent(store, intent, 'expired', 'session_expired', nowUtc, 'Payment window ended before payment');
      changed.push(intent.id);
    } else if (intent.status === 'authorised') {
      moveIntent(store, intent, 'review_required', 'authorisation_expired', nowUtc, 'Authorisation window ended; it must be released');
      changed.push(intent.id);
    }
  }
  return changed;
}
