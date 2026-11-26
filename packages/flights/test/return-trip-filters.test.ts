// Regression tests: return trips are filtered and sorted on the whole itinerary, for both the newer
// journeys shape and the older segments plus returnSegments shape.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { matchesFilters, applyOfferFilters, sortOffers, itineraryDurationMinutes } from '../src/offer-filters.ts';
import { journeysOf, type Offer, type Segment } from '../src/supplier.ts';

function seg(origin: string, destination: string, departureUtc: string, arrivalUtc: string, carrier = 'MK'): Segment {
  return {
    origin,
    destination,
    carrier,
    flightNumber: '100',
    departureUtc,
    arrivalUtc,
    departureTimeZone: 'Africa/Lagos',
    arrivalTimeZone: 'Europe/London',
  } as Segment;
}

// Outbound 08:00 Lagos (07:00Z), 4 hours. Return departs 20:00 Lagos on 10 December, 4 hours.
const outbound = seg('LOS', 'LHR', '2026-12-01T07:00:00Z', '2026-12-01T11:00:00Z');
const eveningReturn = seg('LHR', 'LOS', '2026-12-10T19:00:00Z', '2026-12-10T23:00:00Z', 'BA');

const legacyReturn: Offer = {
  id: 'legacy',
  displayPrice: { amountMinor: 100000, currency: 'USD' },
  expiresAtUtc: '2026-11-30T12:00:00Z',
  segments: [outbound],
  returnSegments: [eveningReturn],
} as unknown as Offer;

const journeysReturn: Offer = {
  id: 'journeys',
  displayPrice: { amountMinor: 90000, currency: 'USD' },
  expiresAtUtc: '2026-11-30T12:00:00Z',
  segments: [outbound],
  journeys: [[outbound], [eveningReturn]],
} as unknown as Offer;

const MORNING = { departureFromMinutes: 0, departureToMinutes: 719 };

describe('return trips: whole-itinerary filtering', () => {
  test('journeysOf reads the legacy return shape as two journeys', () => {
    assert.equal(journeysOf(legacyReturn).length, 2);
    assert.equal(journeysOf(journeysReturn).length, 2);
  });

  test('a departure window fails the trip when the return leaves in the evening', () => {
    assert.equal(matchesFilters(legacyReturn, MORNING), false, 'the outbound alone would pass the morning window');
    assert.equal(matchesFilters(journeysReturn, MORNING), false);
  });

  test('an airline matches when the carrier is on any journey of the return trip', () => {
    assert.equal(matchesFilters(legacyReturn, { airlines: ['MK'] }), true, 'MK flies the outbound');
    assert.equal(matchesFilters(legacyReturn, { airlines: ['BA'] }), true, 'BA flies the return');
    assert.equal(matchesFilters(legacyReturn, { airlines: ['EK'] }), false, 'no journey is with EK');
  });

  test('a duration limit counts each journey', () => {
    // Each leg is exactly 240 minutes. The limit is inclusive, so 240 passes and 239 fails on the return leg.
    assert.equal(matchesFilters(legacyReturn, { maxDurationMinutes: 239 }), false);
    assert.equal(matchesFilters(legacyReturn, { maxDurationMinutes: 240 }), true);
  });

  test('a filter result never keeps a trip with one failing leg', () => {
    const kept = applyOfferFilters([legacyReturn, journeysReturn], { ...MORNING }).map((offer) => offer.id);
    assert.deepEqual(kept, []);
  });
});

describe('return trips: consistent sorting', () => {
  test('duration sort adds both legs, for both shapes', () => {
    assert.equal(itineraryDurationMinutes(journeysOf(legacyReturn)), 480);
    assert.equal(itineraryDurationMinutes(journeysOf(journeysReturn)), 480);
  });

  test('price, duration and departure sorts all give a stable order', () => {
    const cheaper = { ...journeysReturn, id: 'cheap', displayPrice: { amountMinor: 1, currency: 'USD' } } as unknown as Offer;
    const byPrice = sortOffers([legacyReturn, cheaper], 'price').map((offer) => offer.id);
    assert.deepEqual(byPrice, ['cheap', 'legacy']);
    const byDeparture = sortOffers([legacyReturn, journeysReturn], 'departure').map((offer) => offer.id);
    assert.deepEqual(byDeparture, ['journeys', 'legacy'], 'equal departures break ties on id');
  });
});
