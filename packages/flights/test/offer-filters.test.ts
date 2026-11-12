import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { applyOfferFilters, sortOffers, localMinutesOfDay } from '../src/offer-filters.ts';
import type { Offer, Segment } from '../src/supplier.ts';
import { money } from '../../core/src/money.ts';

function segment(over: Partial<Segment>): Segment {
  return {
    origin: 'LOS',
    destination: 'LHR',
    departureUtc: '2026-12-01T08:00:00Z',
    arrivalUtc: '2026-12-01T15:05:00Z',
    departureTimeZone: 'Africa/Lagos',
    arrivalTimeZone: 'Europe/London',
    carrier: 'MK',
    flightNumber: 'MK101',
    ...over,
  };
}

function offer(id: string, priceMinor: number, segments: Segment[], checkedBags: number | null = 1): Offer {
  return {
    id,
    supplierPrice: money(priceMinor, 'USD'),
    displayPrice: money(priceMinor * 1500, 'NGN'),
    expiresAtUtc: '2026-12-01T00:00:00Z',
    segments,
    fare: { checkedBags, cabinBags: 1, refundable: null, changeable: null, restrictions: [] },
  };
}

const direct = offer('direct', 60000, [segment({})]);
const cheapOneStop = offer('one-stop', 40000, [
  segment({ carrier: 'BA', departureUtc: '2026-12-01T20:00:00Z', arrivalUtc: '2026-12-02T00:00:00Z', destination: 'DXB', arrivalTimeZone: 'Asia/Dubai' }),
  segment({ carrier: 'BA', origin: 'DXB', destination: 'LHR', departureUtc: '2026-12-02T02:00:00Z', arrivalUtc: '2026-12-02T06:00:00Z', departureTimeZone: 'Asia/Dubai', arrivalTimeZone: 'Europe/London' }),
], null);

describe('local time helpers', () => {
  test('reads departure in airport local time, not UTC', () => {
    // 08:00 UTC is 09:00 in Lagos (UTC+1)
    assert.equal(localMinutesOfDay('2026-12-01T08:00:00Z', 'Africa/Lagos'), 9 * 60);
  });
});

describe('offer filters', () => {
  test('filters by maximum price', () => {
    assert.deepEqual(applyOfferFilters([direct, cheapOneStop], { maxPriceMinor: 50000 * 1500 }).map((o) => o.id), ['one-stop']);
  });

  test('filters by airline on the outbound carrier', () => {
    assert.deepEqual(applyOfferFilters([direct, cheapOneStop], { airlines: ['BA'] }).map((o) => o.id), ['one-stop']);
  });

  test('filters by departure window in local time', () => {
    // 09:00 local departure falls inside 08:00-10:00
    assert.deepEqual(applyOfferFilters([direct, cheapOneStop], { departureFromMinutes: 8 * 60, departureToMinutes: 10 * 60 }).map((o) => o.id), ['direct']);
  });

  test('filters by arrival window in local time', () => {
    // direct arrives 15:05 London time
    assert.deepEqual(applyOfferFilters([direct], { arrivalFromMinutes: 16 * 60 }).length, 0);
    assert.deepEqual(applyOfferFilters([direct], { arrivalFromMinutes: 15 * 60 }).length, 1);
  });

  test('filters by maximum outbound duration', () => {
    assert.deepEqual(applyOfferFilters([direct, cheapOneStop], { maxDurationMinutes: 8 * 60 }).map((o) => o.id), ['direct']);
  });

  test('filters by stops', () => {
    assert.deepEqual(applyOfferFilters([direct, cheapOneStop], { stops: 'nonstop' }).map((o) => o.id), ['direct']);
    assert.deepEqual(applyOfferFilters([direct, cheapOneStop], { stops: 'max_one' }).map((o) => o.id), ['direct', 'one-stop']);
  });

  test('treats unknown baggage as not matching a checked-bag requirement', () => {
    assert.deepEqual(applyOfferFilters([direct, cheapOneStop], { requireCheckedBags: true }).map((o) => o.id), ['direct']);
  });

  test('no filters returns everything', () => {
    assert.equal(applyOfferFilters([direct, cheapOneStop], {}).length, 2);
  });
});

describe('sorting', () => {
  test('sorts by price, duration and departure, stably', () => {
    assert.deepEqual(sortOffers([direct, cheapOneStop], 'price').map((o) => o.id), ['one-stop', 'direct']);
    assert.deepEqual(sortOffers([cheapOneStop, direct], 'duration').map((o) => o.id), ['direct', 'one-stop']);
    assert.deepEqual(sortOffers([cheapOneStop, direct], 'departure').map((o) => o.id), ['direct', 'one-stop']);
  });

  test('does not mutate its input', () => {
    const input = [direct, cheapOneStop];
    sortOffers(input, 'price');
    assert.deepEqual(input.map((o) => o.id), ['direct', 'one-stop']);
  });
});
