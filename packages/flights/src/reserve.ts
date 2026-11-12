// Reservation: revalidate the fare, then place a supplier HOLD. A hold keeps seats
// until its expiry. It is not a ticket and not a confirmed booking. Nothing here
// charges the customer or issues a ticket. Payment is a separate module that starts
// only after a successful hold and a fresh fare check.

import type { HoldPassenger, FlightSupplier, Offer } from './supplier.ts';
import { SupplierUnavailableError } from './supplier.ts';

export type ReserveOutcome =
  | {
      readonly status: 'hold_placed';
      readonly holdId: string;
      readonly expiresAtUtc: string;
      // Explicit so no caller can mistake a hold for a confirmed booking.
      readonly bookingStatus: 'reservation_pending';
      readonly ticketStatus: 'not_issued';
    }
  | { readonly status: 'fare_changed'; readonly currentOffer: Offer; readonly previousAmountMinor: number; readonly currentAmountMinor: number }
  | { readonly status: 'offer_expired' }
  | { readonly status: 'hold_unsupported' }
  // The request was sent but no answer came back. The hold may or may not exist.
  // The caller must reconcile with the supplier before any retry. Never assume failure.
  | { readonly status: 'hold_unknown'; readonly reconcileWith: string }
  | { readonly status: 'supplier_unavailable'; readonly reason: string; readonly message: string };

export interface ReserveOptions {
  readonly idempotencyKey: string; // booking:{id}:supplier_hold:{attempt}
  readonly acceptedAmountMinor?: number; // the supplier amount the traveller agreed to
}

export async function reserve(
  supplier: FlightSupplier,
  offer: Offer,
  passengers: readonly HoldPassenger[],
  nowUtc: string,
  options: ReserveOptions,
): Promise<ReserveOutcome> {
  if (!supplier.capabilities.holds || !supplier.priceOffer || !supplier.createHold) {
    return { status: 'hold_unsupported' };
  }

  // Step 1: revalidate the fare before anything is held.
  let current: Offer;
  try {
    current = await supplier.priceOffer(offer, nowUtc);
  } catch (error) {
    return failureOutcome(error, 'offer');
  }

  // Step 2: if the price moved, the traveller must agree to the new price first.
  const priceChanged =
    current.supplierPrice.currency !== offer.supplierPrice.currency ||
    current.supplierPrice.amountMinor !== offer.supplierPrice.amountMinor;
  if (priceChanged && options.acceptedAmountMinor !== current.supplierPrice.amountMinor) {
    return {
      status: 'fare_changed',
      currentOffer: current,
      previousAmountMinor: offer.supplierPrice.amountMinor,
      currentAmountMinor: current.supplierPrice.amountMinor,
    };
  }

  // Step 3: place the hold. The idempotency key stops a retry creating a second one.
  try {
    const hold = await supplier.createHold(current, passengers, options.idempotencyKey, nowUtc);
    return {
      status: 'hold_placed',
      holdId: hold.holdId,
      expiresAtUtc: hold.expiresAtUtc,
      bookingStatus: 'reservation_pending',
      ticketStatus: 'not_issued',
    };
  } catch (error) {
    if (error instanceof SupplierUnavailableError && (error.reason === 'timeout' || error.reason === 'provider_error')) {
      return {
        status: 'hold_unknown',
        reconcileWith: `Look up the booking with the supplier using key ${options.idempotencyKey} before retrying.`,
      };
    }
    return failureOutcome(error, 'hold');
  }
}

function failureOutcome(error: unknown, stage: 'offer' | 'hold'): ReserveOutcome {
  if (error instanceof SupplierUnavailableError) {
    if (error.reason === 'offer_expired') return { status: 'offer_expired' };
    return { status: 'supplier_unavailable', reason: error.reason, message: error.message };
  }
  // Anything else is a bug and is rethrown, so it cannot hide behind a friendly message.
  throw error;
}
