import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MockFlightSupplier } from '../src/adapters/mock.ts';
import type { SearchRequest } from '../src/supplier.ts';

const base: SearchRequest = {
  origin: 'LOS',
  destination: 'LHR',
  departureDate: '2026-12-01',
  passengers: 2,
  cabin: 'economy',
  displayCurrency: 'NGN',
};

describe('MockFlightSupplier', () => {
  const supplier = new MockFlightSupplier();

  test('reports itself as mock mode', () => {
    assert.equal(supplier.mode, 'mock');
  });

  test('returns international offers from Lagos with local time zones', async () => {
    const offers = await supplier.search(base);
    assert.equal(offers.length, 1);
    const [segment] = offers[0].segments;
    assert.equal(segment.departureTimeZone, 'Africa/Lagos');
    assert.equal(segment.arrivalTimeZone, 'Europe/London');
  });

  test('is deterministic for the same input', async () => {
    const first = await supplier.search(base);
    const second = await supplier.search(base);
    assert.deepEqual(first, second);
  });

  test('total price scales with passengers and cabin', async () => {
    const [economy] = await supplier.search({ ...base, passengers: 1 });
    const [two] = await supplier.search({ ...base, passengers: 2 });
    const [business] = await supplier.search({ ...base, passengers: 1, cabin: 'business' });
    assert.equal(two.supplierPrice.amountMinor, economy.supplierPrice.amountMinor * 2);
    assert.ok(business.supplierPrice.amountMinor > economy.supplierPrice.amountMinor);
  });

  test('supplier price is USD and display price is in the requested currency', async () => {
    const [offer] = await supplier.search(base);
    assert.equal(offer.supplierPrice.currency, 'USD');
    assert.equal(offer.displayPrice.currency, 'NGN');
  });

  test('returns no offers for an unknown route', async () => {
    assert.deepEqual(await supplier.search({ ...base, destination: 'ZZZ' }), []);
  });

  test('rejects invalid passenger counts and malformed dates', async () => {
    await assert.rejects(supplier.search({ ...base, passengers: 0 }), RangeError);
    await assert.rejects(supplier.search({ ...base, passengers: 10 }), RangeError);
    await assert.rejects(supplier.search({ ...base, departureDate: '01/12/2026' }), RangeError);
  });
});
