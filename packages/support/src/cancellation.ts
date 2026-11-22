// Cancellation options, built from the actual booking status, the supplier's verified state and
// the fare conditions. A cancellation can be requested only when the airline's state is verified
// and matches ours. A request never promises a refund.
//
// Cancellation execution (with the airline) is a separate step, in service.ts, behind a gate.

import type { FulfilmentStatus } from '../../fulfilment/src/status.ts';
import type { PortalBooking } from '../../portal/src/model.ts';

// What the airline reported for the booking. Only the caller can obtain this, from the supplier.
// Today no supplier adapter implements order lookup, so this is 'unavailable' in practice.
export type SupplierCheck =
  | { readonly state: 'verified'; readonly airlineStatus: 'active' | 'cancelled' | 'unknown'; readonly checkedAt: string }
  | { readonly state: 'unavailable'; readonly reason: string };

export type RefundExpectation = 'possible' | 'not_expected' | 'not_confirmed';

export interface CancellationOption {
  readonly kind: 'request_cancellation' | 'support_only';
  readonly refundExpectation: RefundExpectation;
  readonly requiresAcknowledgement: boolean;
  readonly message: string;
}

export interface CancellationOptions {
  readonly options: readonly CancellationOption[];
  readonly blockedReason: string | null;
}

// Statuses in which a cancellation request is meaningful (a supplier order exists).
const CANCELLABLE: readonly FulfilmentStatus[] = ['order_pending', 'ticketing_pending', 'partially_fulfilled', 'ticketed', 'confirmed'];

// Statuses in which a person must check before anything else.
const CHECK_FIRST: readonly FulfilmentStatus[] = ['order_unknown', 'ticketing_unknown'];

function supportOnly(message: string, blockedReason: string | null): CancellationOptions {
  return {
    options: [{ kind: 'support_only', refundExpectation: 'not_confirmed', requiresAcknowledgement: false, message }],
    blockedReason,
  };
}

export function cancellationOptions(booking: PortalBooking, supplier: SupplierCheck): CancellationOptions {
  const status = booking.record.status;

  if (supplier.state === 'unavailable') {
    return supportOnly(
      'We cannot check this booking with the airline right now, so we cannot offer a cancellation here. You can ask us for help and we will review it.',
      supplier.reason,
    );
  }

  if (CHECK_FIRST.includes(status)) {
    return supportOnly('We are checking this booking with the airline. Please wait for our update.', 'Supplier outcome is unknown.');
  }

  if (status === 'cancelled' || status === 'cancellation_pending' || status === 'refund_pending' || status === 'refunded') {
    return {
      options: [],
      blockedReason: 'This booking is already cancelled or being cancelled.',
    };
  }

  if (!CANCELLABLE.includes(status)) {
    return { options: [], blockedReason: 'This booking cannot be cancelled in its current state.' };
  }

  if (supplier.airlineStatus === 'cancelled') {
    return supportOnly(
      'The airline shows this booking as already cancelled, but our records differ. Support will review it.',
      'Airline and GO records differ.',
    );
  }

  if (supplier.airlineStatus === 'unknown') {
    return supportOnly('The airline did not confirm the booking state. Support will review it.', 'Airline state unknown.');
  }

  const refundable = booking.record.offer.fare?.refundable;
  const refundExpectation: RefundExpectation = refundable === true ? 'possible' : refundable === false ? 'not_expected' : 'not_confirmed';
  const acknowledge = refundExpectation !== 'possible';
  const message =
    refundExpectation === 'possible'
      ? 'You can ask us to cancel this booking. Refund eligibility is checked after your request, and a refund is not guaranteed.'
      : refundExpectation === 'not_expected'
        ? 'This fare is not refundable under its fare rules. You can still ask us to cancel, but no refund is expected. Please confirm you understand this.'
        : 'The fare rules for this booking are not confirmed. You can ask us to cancel, but refund eligibility is not confirmed. Please confirm you understand this.';

  return {
    options: [{ kind: 'request_cancellation', refundExpectation, requiresAcknowledgement: acknowledge, message }],
    blockedReason: null,
  };
}
