import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateSearch, validatePassengerMix, toSupplierRequest, type FlightSearchInput } from '../src/search.ts';

const TODAY = '2026-11-12';

const base: FlightSearchInput = {
  tripType: 'one_way',
  origin: 'LOS',
  destination: 'LHR',
  departureDate: '2026-12-01',
  passengers: { adults: 2, children: 0, infants: 0 },
  cabin: 'economy',
  displayCurrency: 'NGN',
};

describe('search validation', () => {
  test('accepts a valid one-way search', () => {
    assert.deepEqual(validateSearch(base, TODAY), { valid: true, errors: {} });
  });

  test('requires a return date for round trips and checks its order', () => {
    const rt = { ...base, tripType: 'round_trip' as const };
    assert.equal(validateSearch(rt, TODAY).errors.returnDate, 'Enter a valid return date.');
    const before = { ...rt, returnDate: '2026-11-30' };
    assert.equal(validateSearch(before, TODAY).errors.returnDate, 'Return date cannot be before departure.');
    assert.equal(validateSearch({ ...rt, returnDate: '2026-12-10' }, TODAY).valid, true);
  });

  test('refuses a return date on a one-way search', () => {
    assert.equal(validateSearch({ ...base, returnDate: '2026-12-10' }, TODAY).errors.returnDate,
      'One-way journeys do not have a return date.');
  });

  test('rejects past, impossible and malformed departure dates', () => {
    assert.equal(validateSearch({ ...base, departureDate: '2026-11-11' }, TODAY).errors.departureDate,
      'Departure date cannot be in the past.');
    assert.equal(validateSearch({ ...base, departureDate: '2026-02-30' }, TODAY).errors.departureDate,
      'Enter a valid departure date.');
    assert.equal(validateSearch({ ...base, departureDate: '01/12/2026' }, TODAY).errors.departureDate,
      'Enter a valid departure date.');
  });

  test('rejects missing, malformed and identical airports', () => {
    assert.ok(validateSearch({ ...base, origin: '' }, TODAY).errors.origin);
    assert.ok(validateSearch({ ...base, destination: 'lhr' }, TODAY).errors.destination);
    assert.equal(validateSearch({ ...base, destination: 'LOS' }, TODAY).errors.destination,
      'Destination must be different from departure.');
  });

  test('rejects unknown cabins and currencies', () => {
    assert.ok(validateSearch({ ...base, cabin: 'couch' as never }, TODAY).errors.cabin);
    assert.ok(validateSearch({ ...base, displayCurrency: 'JPY' as never }, TODAY).errors.displayCurrency);
  });

  test('toSupplierRequest refuses invalid input so no supplier call can be made', () => {
    assert.throws(() => toSupplierRequest({ ...base, origin: 'LOS', destination: 'LOS' }, TODAY), RangeError);
  });
});

describe('passenger selection', () => {
  test('requires at least one adult', () => {
    assert.match(validatePassengerMix({ adults: 0, children: 2, infants: 0 }).passengers, /adult/);
  });

  test('caps travellers at nine', () => {
    assert.deepEqual(validatePassengerMix({ adults: 5, children: 4, infants: 0 }), {});
    assert.match(validatePassengerMix({ adults: 5, children: 4, infants: 1 }).passengers, /up to 9/);
  });

  test('allows at most one infant per adult', () => {
    assert.deepEqual(validatePassengerMix({ adults: 2, children: 0, infants: 2 }), {});
    assert.match(validatePassengerMix({ adults: 1, children: 0, infants: 2 }).passengers, /Each infant/);
  });

  test('rejects negative and fractional counts', () => {
    assert.ok(validatePassengerMix({ adults: -1, children: 0, infants: 0 }).passengers);
    assert.ok(validatePassengerMix({ adults: 1.5, children: 0, infants: 0 }).passengers);
  });

  test('children count as seat-occupying passengers and infants do not', () => {
    const request = toSupplierRequest({ ...base, passengers: { adults: 1, children: 2, infants: 1 } }, TODAY);
    assert.equal(request.passengers, 3);
    assert.equal(request.infants, 1);
  });
});
