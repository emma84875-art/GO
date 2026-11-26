// Turns offers into display values. No DOM here, so the rules are unit tested directly.
//
// The rules that matter most to a customer:
//  - A detail the airline did not confirm (null) is shown as "not confirmed". It is never shown as "none".
//  - Times are shown in the local time of each airport, with "+1 day" when the arrival is on a later date.
//  - Only the supplier's price is shown. GO adds no fee, estimate or currency rate of its own.

import { formatMoney } from '../vendor/packages/core/src/money.js';
import { durationMinutes } from '../vendor/packages/core/src/time.js';
import { applyOfferFilters, sortOffers, outboundStops } from '../vendor/packages/flights/src/offer-filters.js';
import { findAirport } from '../vendor/packages/flights/src/airports.js';
import { offerFiltersFrom } from './flight-logic.js';

const LAGOS = 'Africa/Lagos';

const timeFormat = (zone) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayFormat = (zone) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' });
const dateKeyFormat = (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });

export function localTime(utcIso, zone) {
  return timeFormat(zone).format(new Date(utcIso));
}

export function localDay(utcIso, zone) {
  return dayFormat(zone).format(new Date(utcIso));
}

// Number of calendar days between the departure and arrival local dates (0 same day, 1 next day).
export function dayOffset(departureUtc, departureZone, arrivalUtc, arrivalZone) {
  const departure = Date.parse(dateKeyFormat(departureZone).format(new Date(departureUtc)));
  const arrival = Date.parse(dateKeyFormat(arrivalZone).format(new Date(arrivalUtc)));
  return Math.round((arrival - departure) / 86400000);
}

export function durationLabel(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return `${hours} h ${rest} min`;
  if (hours) return `${hours} h`;
  return `${rest} min`;
}

export function airportName(iata) {
  const airport = findAirport(iata);
  return airport ? `${airport.city} (${airport.iata})` : iata;
}

export function stopsInfo(segments) {
  const count = outboundStops(segments);
  if (count === 0) return { count, text: 'Nonstop' };
  const via = segments.slice(0, -1).map((segment) => airportName(segment.destination));
  return { count, text: `${count} ${count === 1 ? 'stop' : 'stops'} in ${via.join(', ')}` };
}

export function baggageLines(fare) {
  if (!fare) {
    return ['Checked bags: not confirmed by the airline', 'Cabin bag: not confirmed by the airline'];
  }
  const checked = fare.checkedBags === null || fare.checkedBags === undefined
    ? 'Checked bags: not confirmed by the airline'
    : fare.checkedBags === 0
      ? 'No checked bag included'
      : `${fare.checkedBags} checked ${fare.checkedBags === 1 ? 'bag' : 'bags'} included`;
  const cabin = fare.cabinBags === null || fare.cabinBags === undefined
    ? 'Cabin bag: not confirmed by the airline'
    : fare.cabinBags === 0
      ? 'No cabin bag included'
      : `${fare.cabinBags} cabin ${fare.cabinBags === 1 ? 'bag' : 'bags'} included`;
  return [checked, cabin];
}

export function conditionLines(fare) {
  if (!fare) return ['Refund and change terms not confirmed by the airline'];
  const lines = [
    fare.refundable === true
      ? 'Refundable before departure'
      : fare.refundable === false
        ? 'Non-refundable before departure'
        : 'Refund terms not confirmed by the airline',
    fare.changeable === true
      ? 'Changes allowed before departure'
      : fare.changeable === false
        ? 'Changes not allowed before departure'
        : 'Change terms not confirmed by the airline',
  ];
  for (const restriction of fare.restrictions ?? []) lines.push(String(restriction));
  return lines;
}

export function journeyView(segments) {
  const first = segments[0];
  const last = segments[segments.length - 1];
  return {
    carrier: first.carrier || 'Carrier not stated',
    flightNumbers: segments.map((segment) => `${segment.carrier}${segment.flightNumber}`.trim() || 'Flight number not stated').join(', '),
    from: {
      time: localTime(first.departureUtc, first.departureTimeZone),
      day: localDay(first.departureUtc, first.departureTimeZone),
      airport: airportName(first.origin),
    },
    to: {
      time: localTime(last.arrivalUtc, last.arrivalTimeZone),
      day: localDay(last.arrivalUtc, last.arrivalTimeZone),
      airport: airportName(last.destination),
      dayOffset: dayOffset(first.departureUtc, first.departureTimeZone, last.arrivalUtc, last.arrivalTimeZone),
    },
    duration: durationLabel(durationMinutes(first.departureUtc, last.arrivalUtc)),
    stops: stopsInfo(segments),
  };
}

// The journeys of an offer in travel order. Offers from the service carry 'journeys'. Older offers carry
// segments and returnSegments, which is the same thing for one-way and return trips.
export function journeysOfOffer(offer) {
  if (Array.isArray(offer.journeys)) return offer.journeys;
  return offer.returnSegments?.length ? [offer.segments, offer.returnSegments] : [offer.segments];
}

// Labels: a return trip reads Outbound and Return. Anything else (multi-city) reads Journey 1 of 3.
export function journeyLabels(count, tripType) {
  if (tripType === 'round_trip' && count === 2) return ['Outbound', 'Return'];
  return Array.from({ length: count }, (_, index) => `Journey ${index + 1} of ${count}`);
}

// The note that keeps the fare's currency visible. A fare in another currency says so and says it was not
// converted. A fare converted from the airline's currency says what it was converted from.
export function priceNoteFor(offer, requestedCurrency) {
  const shown = offer.displayPrice.currency;
  const fareCurrency = offer.supplierPrice?.currency;
  if (requestedCurrency && shown !== requestedCurrency) {
    return `Shown in ${shown}, the currency the airline sells this fare in. GO has not converted it to ${requestedCurrency}.`;
  }
  if (fareCurrency && fareCurrency !== shown) {
    return `Converted from the airline's fare in ${fareCurrency} at a GO exchange rate.`;
  }
  return null;
}

export function cardFor(offer, tripType = 'one_way', requestedCurrency) {
  const journeys = journeysOfOffer(offer);
  const labels = journeyLabels(journeys.length, tripType);
  return {
    id: offer.id,
    journeys: journeys.map((segments, index) => ({ label: labels[index], view: journeyView(segments) })),
    price: formatMoney(offer.displayPrice, 'en-NG'),
    currencyCode: offer.displayPrice.currency,
    priceNote: priceNoteFor(offer, requestedCurrency),
    expiresLabel: `${localDay(offer.expiresAtUtc, LAGOS)}, ${localTime(offer.expiresAtUtc, LAGOS)} (Lagos time)`,
    baggage: baggageLines(offer.fare),
    conditions: conditionLines(offer.fare),
  };
}

// Carrier codes on every segment of every journey, for the airline filter. The filter matches the same
// set, so every choice offered here can select at least one result.
export function airlinesIn(offers) {
  const codes = offers.flatMap((offer) => journeysOfOffer(offer).flat().map((segment) => segment.carrier));
  return [...new Set(codes.filter(Boolean))].sort();
}

// Applies the filters and the sort, then builds one display card per offer.
export function buildResultCards(offers, options, tripType = 'one_way', requestedCurrency) {
  const filtered = applyOfferFilters(offers, offerFiltersFrom(options));
  const sorted = sortOffers(filtered, options.sort, requestedCurrency);
  // Prices in more than one currency cannot be compared, so the page says so.
  const currencies = new Set(sorted.map((offer) => offer.displayPrice.currency));
  return {
    total: offers.length,
    shown: sorted.length,
    mixedCurrencies: currencies.size > 1,
    cards: sorted.map((offer) => cardFor(offer, tripType, requestedCurrency)),
  };
}
