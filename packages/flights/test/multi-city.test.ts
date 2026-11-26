import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateSearch, toSupplierRequest, MAX_LEGS, type FlightSearchInput } from '../src/search.ts';
import { legsOf, journeysOf, type SearchLeg, type Offer } from '../src/supplier.ts';
import { parseSearchInput } from '../src/search-input.ts';
import { MockFlightSupplier } from '../src/adapters/mock.ts';
import { buildDuffelOfferRequest, normaliseDuffelOffers } from '../src/adapters/duffel.ts';
import { SupplierUnavailableError } from '../src/supplier.ts';

const TODAY = '2026-11-12';
const passengers = { adults: 1, children: 0, infants: 0 };
const leg = (origin: string, destination: string, departureDate: string): SearchLeg => ({ origin, destination, departureDate });
const multi = (legs: readonly SearchLeg[]): FlightSearchInput => ({ tripType: 'multi_city', legs, passengers, cabin: 'economy', displayCurrency: 'NGN' });

const THREE_LEGS = [leg('LOS', 'LHR', '2026-12-01'), leg('LHR', 'DXB', '2026-12-05'), leg('DXB', 'LOS', '2026-12-09')];

describe('multi-city validation', () => {
  test('accepts two to six journeys in travel order', () => {
    assert.deepEqual(validateSearch(multi(THREE_LEGS), TODAY).errors, {});
    assert.equal(validateSearch(multi(THREE_LEGS.slice(0, 2)), TODAY).valid, true);
    const six = Array.from({ length: MAX_LEGS }, (_, i) => leg('LOS', 'LHR', `2026-12-${String(i + 1).padStart(2, '0')}`));
    assert.equal(validateSearch(multi(six), TODAY).valid, true);
  });

  test('refuses fewer than two or more than six journeys', () => {
    assert.match(validateSearch(multi([THREE_LEGS[0]]), TODAY).errors.legs, /at least two/);
    const seven = Array.from({ length: MAX_LEGS + 1 }, () => leg('LOS', 'LHR', '2026-12-01'));
    assert.match(validateSearch(multi(seven), TODAY).errors.legs, /up to 6/);
  });

  test('names the exact leg and field that is wrong', () => {
    const errors = validateSearch(multi([leg('LOS', 'LOS', '2026-12-01'), leg('LHR', 'DXB', '2026-02-30')]), TODAY).errors;
    assert.equal(errors['legs.0.destination'], 'Destination must be different from departure.');
    assert.equal(errors['legs.1.departureDate'], 'Enter a valid departure date.');
  });

  test('journeys must be on or after the one before them', () => {
    const errors = validateSearch(multi([leg('LOS', 'LHR', '2026-12-05'), leg('LHR', 'DXB', '2026-12-01')]), TODAY).errors;
    assert.equal(errors['legs.1.departureDate'], 'Each journey must be on or after the one before it.');
  });

  test('past dates are refused on every leg', () => {
    const errors = validateSearch(multi([leg('LOS', 'LHR', '2026-11-01'), leg('LHR', 'DXB', '2026-12-01')]), TODAY).errors;
    assert.equal(errors['legs.0.departureDate'], 'Departure date cannot be in the past.');
  });

  test('a multi-city search cannot carry a return date, and a one-way search cannot carry legs', () => {
    assert.match(validateSearch({ ...multi(THREE_LEGS), returnDate: '2026-12-10' }, TODAY).errors.returnDate, /do not have a return date/);
    const oneWay = { tripType: 'one_way' as const, origin: 'LOS', destination: 'LHR', departureDate: '2026-12-01', legs: THREE_LEGS, passengers, cabin: 'economy' as const, displayCurrency: 'NGN' as const };
    assert.match(validateSearch(oneWay, TODAY).errors.legs, /Only multi-city/);
  });

  test('the supplier request carries every leg and the first leg in the plain fields', () => {
    const request = toSupplierRequest(multi(THREE_LEGS), TODAY);
    assert.deepEqual(request.legs, THREE_LEGS);
    assert.equal(request.origin, 'LOS');
    assert.equal(request.departureDate, '2026-12-01');
    assert.equal(request.returnDate, undefined);
    assert.deepEqual(legsOf(request), THREE_LEGS);
  });

  test('legsOf gives one leg for one-way and two for return, reversed', () => {
    const oneWay = toSupplierRequest({ tripType: 'one_way', origin: 'LOS', destination: 'LHR', departureDate: '2026-12-01', passengers, cabin: 'economy', displayCurrency: 'NGN' }, TODAY);
    assert.deepEqual(legsOf(oneWay), [leg('LOS', 'LHR', '2026-12-01')]);
    const roundTrip = toSupplierRequest({ tripType: 'round_trip', origin: 'LOS', destination: 'LHR', departureDate: '2026-12-01', returnDate: '2026-12-10', passengers, cabin: 'economy', displayCurrency: 'NGN' }, TODAY);
    assert.deepEqual(legsOf(roundTrip), [leg('LOS', 'LHR', '2026-12-01'), leg('LHR', 'LOS', '2026-12-10')]);
  });
});

describe('strict request parsing', () => {
  const valid = {
    tripType: 'multi_city',
    legs: THREE_LEGS,
    passengers: { adults: 2, children: 1, infants: 0 },
    cabin: 'business',
    displayCurrency: 'USD',
  };

  test('a well-formed multi-city body parses to the shared input', () => {
    const parsed = parseSearchInput(valid);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.input.tripType, 'multi_city');
      assert.equal(parsed.input.legs?.length, 3);
      assert.deepEqual(validateSearch(parsed.input, TODAY).errors, {});
    }
  });

  test('a well-formed one-way and return body parse', () => {
    const oneWay = parseSearchInput({ tripType: 'one_way', origin: 'LOS', destination: 'LHR', departureDate: '2026-12-01', passengers: { adults: 1 }, cabin: 'economy', displayCurrency: 'NGN' });
    assert.equal(oneWay.ok, true);
    const roundTrip = parseSearchInput({ tripType: 'round_trip', origin: 'LOS', destination: 'LHR', departureDate: '2026-12-01', returnDate: '2026-12-10', passengers: { adults: 1 }, cabin: 'economy', displayCurrency: 'NGN' });
    assert.equal(roundTrip.ok, true);
  });

  test('non-objects, unknown trip types and unknown fields are refused', () => {
    assert.equal(parseSearchInput('LOS').ok, false);
    assert.equal(parseSearchInput([]).ok, false);
    assert.ok(!parseSearchInput({ ...valid, tripType: 'circle' }).ok);
    const extra = parseSearchInput({ ...valid, passengerNames: ['A'] });
    assert.equal(extra.ok, false);
    if (!extra.ok) assert.ok('unknownField' in extra.errors);
  });

  test('error messages never echo what the client sent', () => {
    const attack = 'EVIL<script>';
    const parsed = parseSearchInput({ ...valid, [attack]: 'x', legs: [{ origin: attack, destination: 'LHR', departureDate: '2026-12-01' }, leg('LHR', 'DXB', '2026-12-05')] });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(JSON.stringify(parsed.errors).includes('EVIL'), false);
  });

  test('a leg with an extra field, or a list that is far too long, is refused', () => {
    const extraField = parseSearchInput({ ...valid, legs: [{ ...THREE_LEGS[0], traveller: 'x' }, THREE_LEGS[1]] });
    assert.equal(extraField.ok, false);
    const tooMany = parseSearchInput({ ...valid, legs: Array.from({ length: 50 }, () => THREE_LEGS[0]) });
    assert.equal(tooMany.ok, false);
    if (!tooMany.ok) assert.match(tooMany.errors.legs, /up to 6/);
  });

  test('passenger counts must be whole numbers and adults are required', () => {
    assert.equal(parseSearchInput({ ...valid, passengers: { adults: 1.5 } }).ok, false);
    assert.equal(parseSearchInput({ ...valid, passengers: { children: 2 } }).ok, false);
    assert.equal(parseSearchInput({ ...valid, passengers: { adults: '2' } }).ok, false);
  });

  test('a string over the airport or date size limit is refused before any validation', () => {
    const long = parseSearchInput({ tripType: 'one_way', origin: 'LOSSSSSS', destination: 'LHR', departureDate: '2026-12-01', passengers: { adults: 1 }, cabin: 'economy', displayCurrency: 'NGN' });
    assert.equal(long.ok, false);
  });
});

describe('mock fixture multi-city offers', () => {
  const supplier = new MockFlightSupplier();

  test('a multi-city search returns one offer with every journey', async () => {
    // The fixture only has routes departing from Lagos, so the legs are chosen from it.
    const legs = [leg('LOS', 'LHR', '2026-12-01'), leg('LOS', 'DXB', '2026-12-05')];
    const request = toSupplierRequest(multi(legs), TODAY);
    const offers = await supplier.search(request);
    assert.equal(offers.length, 1);
    assert.equal(journeysOf(offers[0]).length, 2);
  });

  test('a multi-city search with an unknown leg returns no offer', async () => {
    const request = toSupplierRequest(multi([leg('LOS', 'LHR', '2026-12-01'), leg('LHR', 'ACC', '2026-12-05')]), TODAY);
    assert.deepEqual(await supplier.search(request), []);
  });

  test('one-way and return fixture offers keep their existing shape', async () => {
    const [offer] = await supplier.search({ origin: 'LOS', destination: 'LHR', departureDate: '2026-12-01', returnDate: '2026-12-10', passengers: 1, cabin: 'economy', displayCurrency: 'NGN' });
    assert.equal(offer.returnSegments?.length, 1);
    assert.equal(journeysOf(offer).length, 2);
  });
});

describe('Duffel mapping of journeys', () => {
  const request = toSupplierRequest(multi(THREE_LEGS), TODAY);

  test('every leg becomes one slice, in order', () => {
    const body = buildDuffelOfferRequest(request) as { data: { slices: { origin: string; destination: string; departure_date: string }[] } };
    assert.deepEqual(body.data.slices.map((slice) => [slice.origin, slice.destination, slice.departure_date]), [
      ['LOS', 'LHR', '2026-12-01'],
      ['LHR', 'DXB', '2026-12-05'],
      ['DXB', 'LOS', '2026-12-09'],
    ]);
  });

  test('a one-way request still makes exactly one slice', () => {
    const oneWay = toSupplierRequest({ tripType: 'one_way', origin: 'LOS', destination: 'LHR', departureDate: '2026-12-01', passengers, cabin: 'economy', displayCurrency: 'NGN' }, TODAY);
    const body = buildDuffelOfferRequest(oneWay) as { data: { slices: unknown[] } };
    assert.equal(body.data.slices.length, 1);
  });

  const segment = (origin: string, destination: string, departing: string, arriving: string) => ({
    departing_at: departing,
    arriving_at: arriving,
    origin: { iata_code: origin, time_zone: 'Africa/Lagos' },
    destination: { iata_code: destination, time_zone: 'Europe/London' },
    marketing_carrier: { iata_code: 'TT' },
    marketing_carrier_flight_number: '100',
  });
  const payload = (slices: unknown[]) => ({
    data: {
      offers: [{ id: 'off_1', total_amount: '1000.00', total_currency: 'USD', expires_at: '2026-11-30T12:00:00Z', slices }],
    },
  });
  const threeSlices = [
    { segments: [segment('LOS', 'LHR', '2026-12-01T08:00:00Z', '2026-12-01T15:00:00Z')] },
    { segments: [segment('LHR', 'DXB', '2026-12-05T08:00:00Z', '2026-12-05T18:00:00Z')] },
    { segments: [segment('DXB', 'LOS', '2026-12-09T08:00:00Z', '2026-12-09T16:00:00Z')] },
  ];

  test('a multi-city offer carries every journey and no return fields', () => {
    const [offer]: Offer[] = normaliseDuffelOffers(payload(threeSlices), 'USD', undefined, { expectedJourneys: 3, multiCity: true });
    assert.equal(journeysOf(offer).length, 3);
    assert.equal(offer.returnSegments, undefined);
  });

  test('an offer with a different number of journeys from the request is counted as malformed, not shown', () => {
    assert.deepEqual(normaliseDuffelOffers(payload(threeSlices.slice(0, 2)), 'USD', undefined, { expectedJourneys: 3, multiCity: true }), []);
  });

  test('an offer with no journeys is counted as malformed, not shown', () => {
    assert.deepEqual(normaliseDuffelOffers(payload([]), 'USD'), []);
  });
});
