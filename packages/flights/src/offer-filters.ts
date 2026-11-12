// Filters and sorting for flight offers. Times are shown and filtered in airport
// local time. Duration, stops and times apply to the OUTBOUND journey. Baggage
// filters treat an unknown allowance (null) as not matching, and the UI must say so.

import { durationMinutes } from '../../core/src/time.ts';
import type { Offer, Segment } from './supplier.ts';

export type StopsFilter = 'any' | 'nonstop' | 'max_one';
export type OfferSort = 'price' | 'duration' | 'departure';

export interface OfferFilters {
  readonly maxPriceMinor?: number; // in displayPrice minor units
  readonly airlines?: readonly string[]; // carrier codes, e.g. ["MK"]
  readonly departureFromMinutes?: number; // minutes after local midnight
  readonly departureToMinutes?: number;
  readonly arrivalFromMinutes?: number;
  readonly arrivalToMinutes?: number;
  readonly maxDurationMinutes?: number;
  readonly stops?: StopsFilter;
  readonly requireCheckedBags?: boolean;
}

export function localMinutesOfDay(utcIso: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(utcIso));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  return hour * 60 + minute;
}

export function outboundDurationMinutes(segments: readonly Segment[]): number {
  const first = segments[0];
  const last = segments[segments.length - 1];
  return durationMinutes(first.departureUtc, last.arrivalUtc);
}

export function outboundStops(segments: readonly Segment[]): number {
  return Math.max(0, segments.length - 1);
}

function inRange(value: number, from?: number, to?: number): boolean {
  if (from !== undefined && value < from) return false;
  if (to !== undefined && value > to) return false;
  return true;
}

export function matchesFilters(offer: Offer, filters: OfferFilters): boolean {
  const first = offer.segments[0];
  const last = offer.segments[offer.segments.length - 1];

  if (filters.maxPriceMinor !== undefined && offer.displayPrice.amountMinor > filters.maxPriceMinor) return false;

  if (filters.airlines && filters.airlines.length > 0 && !filters.airlines.includes(first.carrier)) return false;

  const departMinutes = localMinutesOfDay(first.departureUtc, first.departureTimeZone);
  if (!inRange(departMinutes, filters.departureFromMinutes, filters.departureToMinutes)) return false;

  const arriveMinutes = localMinutesOfDay(last.arrivalUtc, last.arrivalTimeZone);
  if (!inRange(arriveMinutes, filters.arrivalFromMinutes, filters.arrivalToMinutes)) return false;

  if (filters.maxDurationMinutes !== undefined && outboundDurationMinutes(offer.segments) > filters.maxDurationMinutes) {
    return false;
  }

  const stops = outboundStops(offer.segments);
  if (filters.stops === 'nonstop' && stops !== 0) return false;
  if (filters.stops === 'max_one' && stops > 1) return false;

  if (filters.requireCheckedBags && !((offer.fare?.checkedBags ?? 0) > 0)) return false;

  return true;
}

export function applyOfferFilters(offers: readonly Offer[], filters: OfferFilters): readonly Offer[] {
  return offers.filter((offer) => matchesFilters(offer, filters));
}

// Sorts a copy. Ties break on id so the order is stable and repeatable.
export function sortOffers(offers: readonly Offer[], sort: OfferSort): readonly Offer[] {
  const key = (offer: Offer): number => {
    if (sort === 'price') return offer.displayPrice.amountMinor;
    if (sort === 'duration') return outboundDurationMinutes(offer.segments);
    return Date.parse(offer.segments[0].departureUtc);
  };
  return [...offers].sort((a, b) => key(a) - key(b) || a.id.localeCompare(b.id));
}
