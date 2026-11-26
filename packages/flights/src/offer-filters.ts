// Filters and sorting for flight offers. Times are shown and filtered in airport
// local time. Times, duration and stops apply to EVERY journey of the itinerary
// (one-way, return or multi-city). An airline matches when at least one segment of
// the itinerary is with that carrier. Baggage filters treat an unknown allowance
// (null) as not matching, and the UI must say so.

import { durationMinutes } from '../../core/src/time.ts';
import type { CurrencyCode } from '../../core/src/money.ts';
import { journeysOf, type Offer, type Segment } from './supplier.ts';

export type StopsFilter = 'any' | 'nonstop' | 'max_one';
export type OfferSort = 'price' | 'duration' | 'departure';

export interface OfferFilters {
  // A price limit applies only to offers in maxPriceCurrency. Offers in another currency are left out, because
  // their amounts cannot be compared with the limit.
  readonly maxPriceMinor?: number;
  readonly maxPriceCurrency?: CurrencyCode;
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

// Every journey of the itinerary must satisfy a time, airline, duration or stops filter. For a one-way
// offer that is the single journey. For a return or multi-city offer it is every journey, so a filter
// never looks at only the first journey and hides a problem on a later one.
export function itineraryDurationMinutes(journeys: readonly (readonly Segment[])[]): number {
  return journeys.reduce((total, journey) => total + outboundDurationMinutes(journey), 0);
}

export function matchesFilters(offer: Offer, filters: OfferFilters): boolean {
  if (filters.maxPriceMinor !== undefined) {
    if (filters.maxPriceCurrency === undefined || offer.displayPrice.currency !== filters.maxPriceCurrency) return false;
    if (offer.displayPrice.amountMinor > filters.maxPriceMinor) return false;
  }

  const journeys = journeysOf(offer);

  // An airline matches when at least one segment of the itinerary is with that carrier, on any journey.
  if (filters.airlines && filters.airlines.length > 0) {
    const carriers = journeys.flatMap((journey) => journey.map((segment) => segment.carrier));
    if (!filters.airlines.some((code) => carriers.includes(code))) return false;
  }

  for (const journey of journeys) {
    const first = journey[0];
    const last = journey[journey.length - 1];

    const departMinutes = localMinutesOfDay(first.departureUtc, first.departureTimeZone);
    if (!inRange(departMinutes, filters.departureFromMinutes, filters.departureToMinutes)) return false;

    const arriveMinutes = localMinutesOfDay(last.arrivalUtc, last.arrivalTimeZone);
    if (!inRange(arriveMinutes, filters.arrivalFromMinutes, filters.arrivalToMinutes)) return false;

    if (filters.maxDurationMinutes !== undefined && outboundDurationMinutes(journey) > filters.maxDurationMinutes) {
      return false;
    }

    const stops = outboundStops(journey);
    if (filters.stops === 'nonstop' && stops !== 0) return false;
    if (filters.stops === 'max_one' && stops > 1) return false;
  }

  if (filters.requireCheckedBags && !((offer.fare?.checkedBags ?? 0) > 0)) return false;

  return true;
}

export function applyOfferFilters(offers: readonly Offer[], filters: OfferFilters): readonly Offer[] {
  return offers.filter((offer) => matchesFilters(offer, filters));
}

// Sorts a copy. Price sorts group offers by currency first, because amounts in different currencies cannot
// be compared. Offers in preferredCurrency come first (GO's default is NGN), then the other currencies in
// code order. Ties break on id so the order is stable and repeatable.
export function sortOffers(offers: readonly Offer[], sort: OfferSort, preferredCurrency?: CurrencyCode): readonly Offer[] {
  const key = (offer: Offer): number => {
    if (sort === 'price') return offer.displayPrice.amountMinor;
    // Duration sorts on the whole itinerary (all journeys added together). Departure sorts on the first journey.
    if (sort === 'duration') return itineraryDurationMinutes(journeysOf(offer));
    return Date.parse(journeysOf(offer)[0][0].departureUtc);
  };
  const rank = (offer: Offer): number => (offer.displayPrice.currency === preferredCurrency ? 0 : 1);
  const compare = (a: Offer, b: Offer): number => {
    if (sort === 'price' && a.displayPrice.currency !== b.displayPrice.currency) {
      return rank(a) - rank(b) || a.displayPrice.currency.localeCompare(b.displayPrice.currency);
    }
    return key(a) - key(b) || a.id.localeCompare(b.id);
  };
  return [...offers].sort(compare);
}
