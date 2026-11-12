// Booking summary: itinerary, passengers, baggage, fare conditions, taxes and fees.
// Anything the supplier did not state is shown as "not confirmed". It is never shown
// as "none" or "included". Taxes are not yet confirmed by any supplier, so they are
// always reported as not confirmed.

import { formatMoney, type Money } from '../../core/src/money.ts';
import { applyFees, type FeePolicy } from '../../core/src/pricing.ts';
import { formatLocalTime, durationMinutes } from '../../core/src/time.ts';
import type { Offer, Segment } from './supplier.ts';

// Placeholder. No fee decision has been made, so the policy is zero. Replace it
// with the approved fee schedule before any charge is made.
export const UNDECIDED_FEE_POLICY: FeePolicy = { serviceFeeBasisPoints: 0, fixedFeeMinor: 0 };

export interface SummarySegment {
  readonly flight: string;
  readonly from: string;
  readonly to: string;
  readonly departs: string; // local airport time
  readonly arrives: string; // local airport time
  readonly durationMinutes: number;
}

export interface BookingSummary {
  readonly outbound: readonly SummarySegment[];
  readonly inbound: readonly SummarySegment[];
  readonly baggage: { readonly checked: string; readonly cabin: string };
  readonly restrictions: readonly string[];
  readonly refundable: string;
  readonly changeable: string;
  readonly fare: string; // formatted base fare
  readonly serviceFee: string; // formatted fee
  readonly taxes: 'Not confirmed by supplier';
  readonly total: string; // formatted, excludes taxes until confirmed
  readonly totalMinor: number;
  readonly currency: Money['currency'];
  readonly notes: readonly string[];
}

function summariseSegment(segment: Segment): SummarySegment {
  return {
    flight: `${segment.carrier} ${segment.flightNumber}`.trim(),
    from: segment.origin,
    to: segment.destination,
    departs: formatLocalTime(segment.departureUtc, segment.departureTimeZone),
    arrives: formatLocalTime(segment.arrivalUtc, segment.arrivalTimeZone),
    durationMinutes: durationMinutes(segment.departureUtc, segment.arrivalUtc),
  };
}

function bagText(value: number | null, unit: string): string {
  if (value === null) return 'Not confirmed by supplier';
  if (value === 0) return `No ${unit} included`;
  return `${value} ${unit}${value === 1 ? '' : 's'} included`;
}

function yesNo(value: boolean | null): string {
  if (value === null) return 'Not confirmed by supplier';
  return value ? 'Yes' : 'No';
}

export function buildBookingSummary(offer: Offer, policy: FeePolicy = UNDECIDED_FEE_POLICY): BookingSummary {
  const base = offer.displayPrice;
  const { fee, total } = applyFees(base, policy);
  const fare = offer.fare;

  return {
    outbound: offer.segments.map(summariseSegment),
    inbound: (offer.returnSegments ?? []).map(summariseSegment),
    baggage: {
      checked: bagText(fare?.checkedBags ?? null, 'checked bag'),
      cabin: bagText(fare?.cabinBags ?? null, 'cabin bag'),
    },
    restrictions: fare?.restrictions ?? [],
    refundable: yesNo(fare?.refundable ?? null),
    changeable: yesNo(fare?.changeable ?? null),
    fare: formatMoney(base),
    serviceFee: formatMoney(fee),
    taxes: 'Not confirmed by supplier',
    total: formatMoney(total),
    totalMinor: total.amountMinor,
    currency: total.currency,
    notes: [
      'Taxes are not included until the supplier confirms them.',
      'Seats are held, not ticketed, until payment and supplier confirmation are complete.',
    ],
  };
}
