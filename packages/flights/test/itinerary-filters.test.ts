import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { matchesFilters, applyOfferFilters, sortOffers } from '../src/offer-filters.ts';
import type { Offer, Segment } from '../src/supplier.ts';

// Times are chosen so the Lagos local times are easy to read: 19:00Z is 20:00 in Lagos (UTC+1).
function seg(overrides: Partial<Segment> & { origin: string; destination: string }): Segment {
  return {
    carrier: 'MK',
    flightNumber: '100',
    departureUtc: '2026-12-01T08:00:00Z',
    arrivalUtc: '2026-12-01T12:00:00Z',
    departureTimeZone: 'Africa/Lagos',
    arrivalTimeZone: 'Europe/London',
    ...overrides,
  } as Segment;
}

function itinerary(journeys: Segment[][], id = 'o1'): Offer {
  return {
    id,
    displayPrice: { amountMinor: 100000, currency: 'USD' },
    expiresAtUtc: '2026-11-30T12:00:00Z',
    segments: journeys[0],
    journeys,
  } as unknown as Offer;
}

const MORNING = { departureFromMinutes: 0, departureToMinutes: 719 };

describe('whole-itinerary filters', () => {
  const lateSecond = itinerary([
    [seg({ origin: 'LOS', destination: 'LHR', departureUtc: '2026-12-01T06:00:00Z', arrivalUtc: '2026-12-01T11:00:00Z' })],
    [seg({ origin: 'LHR', destination: 'DXB', departureUtc: '2026-12-05T19:00:00Z', arrivalUtc: '2026-12-05T23:00:00Z' })],
  ]);

  test('a departure window applies to a later journey, not only the first', () => {
    assert.equal(matchesFilters(lateSecond, MORNING), false, 'second journey departs at 20:00 local');
  });

  test('an airline matches when the carrier is on any journey', () => {
    const mixed = itinerary([
      [seg({ origin: 'LOS', destination: 'LHR', carrier: 'MK' })],
      [seg({ origin: 'LHR', destination: 'DXB', carrier: 'BA' })],
    ]);
    assert.equal(matchesFilters(mixed, { airlines: ['MK'] }), true);
    assert.equal(matchesFilters(mixed, { airlines: ['BA'] }), true);
    assert.equal(matchesFilters(mixed, { airlines: ['EK'] }), false);
  });

  test('a stops filter applies to every journey, so a connection on a later leg is seen', () => {
    const connecting = itinerary([
      [seg({ origin: 'LOS', destination: 'LHR' })],
      [
        seg({ origin: 'LHR', destination: 'IST' }),
        seg({ origin: 'IST', destination: 'DXB', departureUtc: '2026-12-05T14:00:00Z', arrivalUtc: '2026-12-05T18:00:00Z' }),
      ],
    ]);
    assert.equal(matchesFilters(connecting, { stops: 'nonstop' }), false);
    assert.equal(matchesFilters(connecting, { stops: 'max_one' }), true);
  });

  test('a duration limit applies to every journey', () => {
    const longLater = itinerary([
      [seg({ origin: 'LOS', destination: 'LHR', departureUtc: '2026-12-01T08:00:00Z', arrivalUtc: '2026-12-01T10:00:00Z' })],
      [seg({ origin: 'LHR', destination: 'DXB', departureUtc: '2026-12-05T08:00:00Z', arrivalUtc: '2026-12-05T20:00:00Z' })],
    ]);
    assert.equal(matchesFilters(longLater, { maxDurationMinutes: 300 }), false);
    assert.equal(matchesFilters(longLater, { maxDurationMinutes: 720 }), true);
  });

  test('an arrival window applies to the last journey, not only the first', () => {
    const lateArrival = itinerary([
      [seg({ origin: 'LOS', destination: 'LHR', departureUtc: '2026-12-01T06:00:00Z', arrivalUtc: '2026-12-01T11:00:00Z' })],
      [seg({ origin: 'LHR', destination: 'DXB', departureUtc: '2026-12-05T08:00:00Z', arrivalUtc: '2026-12-05T23:30:00Z' })],
    ]);
    // Arrival is 23:30 in London (December, UTC+0), after the 20:00 cut-off.
    assert.equal(matchesFilters(lateArrival, { arrivalFromMinutes: 0, arrivalToMinutes: 1200 }), false);
  });

  test('the filter result lists only offers whose every journey passes', () => {
    // ok departs 08:00 Lagos on both journeys, so it passes the morning window. lateSecond fails it.
    const okMorning = itinerary([
      [seg({ origin: 'LOS', destination: 'LHR', departureUtc: '2026-12-01T06:00:00Z' })],
      [seg({ origin: 'LHR', destination: 'DXB', departureUtc: '2026-12-05T06:00:00Z', arrivalUtc: '2026-12-05T10:00:00Z' })],
    ], 'ok');
    const kept = applyOfferFilters([lateSecond, okMorning], MORNING).map((offer) => offer.id);
    assert.deepEqual(kept, ['ok']);
  });
});

describe('whole-itinerary sorting', () => {
  test('duration sort adds the journeys together', () => {
    const short = itinerary([[seg({ origin: 'LOS', destination: 'LHR', departureUtc: '2026-12-01T08:00:00Z', arrivalUtc: '2026-12-01T10:00:00Z' })]], 'short');
    const twoLegs = itinerary([
      [seg({ origin: 'LOS', destination: 'LHR', departureUtc: '2026-12-01T08:00:00Z', arrivalUtc: '2026-12-01T09:00:00Z' })],
      [seg({ origin: 'LHR', destination: 'DXB', departureUtc: '2026-12-05T08:00:00Z', arrivalUtc: '2026-12-05T09:00:00Z' })],
    ], 'two');
    assert.deepEqual(sortOffers([twoLegs, short], 'duration').map((offer) => offer.id), ['short', 'two']);
  });

  test('one-way offers behave as before', () => {
    const oneWay = itinerary([[seg({ origin: 'LOS', destination: 'LHR', departureUtc: '2026-12-01T08:00:00Z', arrivalUtc: '2026-12-01T12:00:00Z' })]]);
    assert.equal(matchesFilters(oneWay, { ...MORNING, stops: 'nonstop' }), true);
  });
});
