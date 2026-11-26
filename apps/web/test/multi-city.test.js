// Multi-city search in the web app, the search endpoint rules, journey labels and the build's CSP checks.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  inputFromParams,
  paramsFromInput,
  parseLegsParam,
  legsParam,
  hasDates,
  searchHash,
  validateInput,
  MAX_URL_LEGS,
} from '../src/js/flight-logic.js';
import { createSearchSupplier, isOfferShape, isUsableEndpoint } from '../src/js/flight-client.js';
import { journeyLabels, journeysOfOffer } from '../src/js/flight-view.js';
import { searchOriginFor, connectSrcProblems, SEARCH_PLACEHOLDER } from '../../../scripts/build-web.mjs';

const TODAY = '2026-11-24';
const ENDPOINT = 'https://search.example.test/api/flights/search';

const segment = (overrides = {}) => ({
  origin: 'LOS',
  destination: 'LHR',
  carrier: 'BA',
  flightNumber: '75',
  departureTimeZone: 'Africa/Lagos',
  arrivalTimeZone: 'Europe/London',
  departureUtc: '2026-12-01T10:00:00Z',
  arrivalUtc: '2026-12-01T17:00:00Z',
  ...overrides,
});

describe('multi-city in the URL', () => {
  test('legs round-trip through the legs parameter, dates keep their dashes', () => {
    const legs = parseLegsParam('LOS-LHR-2026-12-01,LHR-DXB-2026-12-05');
    assert.deepEqual(legs, [
      { origin: 'LOS', destination: 'LHR', departureDate: '2026-12-01' },
      { origin: 'LHR', destination: 'DXB', departureDate: '2026-12-05' },
    ]);
    assert.equal(legsParam(legs), 'LOS-LHR-2026-12-01,LHR-DXB-2026-12-05');
  });

  test('a long legs list is capped so the URL cannot grow without limit', () => {
    const many = Array.from({ length: 50 }, () => 'LOS-LHR-2026-12-01').join(',');
    assert.equal(parseLegsParam(many).length, MAX_URL_LEGS);
  });

  test('inputFromParams builds the multi-city shape from the URL', () => {
    const input = inputFromParams({ trip: 'multi_city', legs: 'LOS-LHR-2026-12-01,LHR-DXB-2026-12-05', adults: '2', cabin: 'business', currency: 'USD' });
    assert.equal(input.tripType, 'multi_city');
    assert.equal(input.legs.length, 2);
    assert.equal(input.passengers.adults, 2);
    assert.equal(input.origin, undefined, 'single journey fields are not set for multi-city');
  });

  test('paramsFromInput and searchHash keep the legs and drop the single journey fields', () => {
    const input = inputFromParams({ trip: 'multi_city', legs: 'LOS-LHR-2026-12-01,LHR-DXB-2026-12-05' });
    const params = paramsFromInput(input);
    assert.equal(params.get('trip'), 'multi_city');
    assert.equal(params.get('legs'), 'LOS-LHR-2026-12-01,LHR-DXB-2026-12-05');
    assert.equal(params.has('from'), false);
    const hash = searchHash(Object.fromEntries(params), {});
    assert.ok(hash.includes('legs='));
  });

  test('multi-city has dates only when it has journeys', () => {
    assert.equal(hasDates({ trip: 'multi_city', legs: 'LOS-LHR-2026-12-01' }), true);
    assert.equal(hasDates({ trip: 'multi_city' }), false);
  });

  test('a one-way and return URL still reads as before', () => {
    const oneWay = inputFromParams({ trip: 'one_way', from: 'los', to: 'lhr', depart: '2026-12-01' });
    assert.equal(oneWay.origin, 'LOS');
    assert.equal(oneWay.tripType, 'one_way');
    const roundTrip = inputFromParams({ trip: 'round_trip', from: 'LOS', to: 'LHR', depart: '2026-12-01', return: '2026-12-10' });
    assert.equal(roundTrip.returnDate, '2026-12-10');
  });
});

describe('multi-city validation (the same rules the server uses)', () => {
  test('the bad journey is named by its position', () => {
    const input = inputFromParams({ trip: 'multi_city', legs: 'LOS-LHR-2026-12-05,LHR-DXB-2026-12-01' });
    const errors = validateInput(input, TODAY);
    assert.equal(errors['legs.1.departureDate'], 'Each journey must be on or after the one before it.');
  });

  test('a journey from an airport to itself is refused', () => {
    const errors = validateInput(inputFromParams({ trip: 'multi_city', legs: 'LOS-LOS-2026-12-01,LOS-LHR-2026-12-05' }), TODAY);
    assert.equal(errors['legs.0.destination'], 'Destination must be different from departure.');
  });

  test('one journey is not enough', () => {
    const errors = validateInput(inputFromParams({ trip: 'multi_city', legs: 'LOS-LHR-2026-12-01' }), TODAY);
    assert.equal(errors.legs, 'Add at least two journeys for a multi-city search.');
  });
});

describe('endpoint rules', () => {
  test('https endpoints are usable, plain http only on localhost', () => {
    assert.equal(isUsableEndpoint(ENDPOINT), true);
    assert.equal(isUsableEndpoint('http://localhost:3001/api/flights/search'), true);
    assert.equal(isUsableEndpoint('http://search.example.test/api/flights/search'), false);
  });

  test('relative paths, credentials, other schemes and empty values are refused', () => {
    assert.equal(isUsableEndpoint('/api/flights/search'), false);
    assert.equal(isUsableEndpoint('https://user:pass@search.example.test/api'), false);
    assert.equal(isUsableEndpoint('javascript:alert(1)'), false);
    assert.equal(isUsableEndpoint(''), false);
    assert.equal(isUsableEndpoint(null), false);
  });

  test('an unusable endpoint is not connected, and no request is sent', async () => {
    let calls = 0;
    const supplier = createSearchSupplier({ endpoint: '/relative', input: {}, fetchImpl: async () => { calls += 1; } });
    await assert.rejects(() => supplier.search(), (error) => error.reason === 'not_configured');
    assert.equal(calls, 0);
  });

  test('the client posts the customer input, so the service can validate it', async () => {
    let sent;
    const input = inputFromParams({ trip: 'multi_city', legs: 'LOS-LHR-2026-12-01,LHR-DXB-2026-12-05', adults: '1' });
    const supplier = createSearchSupplier({
      endpoint: ENDPOINT,
      input,
      fetchImpl: async (url, init) => {
        sent = { url, init };
        return { ok: true, status: 200, json: async () => ({ status: 'empty', offers: [] }) };
      },
    });
    assert.deepEqual(await supplier.search({ origin: 'ignored' }), []);
    const body = JSON.parse(sent.init.body);
    assert.equal(body.tripType, 'multi_city');
    assert.equal(body.legs.length, 2);
    assert.equal(sent.init.credentials, 'omit');
  });

  test('a service-named unavailable reason is passed through', async () => {
    const supplier = createSearchSupplier({
      endpoint: ENDPOINT,
      input: inputFromParams({ trip: 'one_way', from: 'LOS', to: 'LHR', depart: '2026-12-01' }),
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ status: 'unavailable', reason: 'not_configured' }) }),
    });
    await assert.rejects(() => supplier.search(), (error) => error.reason === 'not_configured');
  });

  test('an unknown reason from the service becomes provider_error', async () => {
    const supplier = createSearchSupplier({
      endpoint: ENDPOINT,
      input: inputFromParams({ trip: 'one_way', from: 'LOS', to: 'LHR', depart: '2026-12-01' }),
      fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({ status: 'unavailable', reason: 'made_up_reason' }) }),
    });
    await assert.rejects(() => supplier.search(), (error) => error.reason === 'provider_error');
  });
});

describe('offers with journeys', () => {
  test('an offer with journeys passes the shape check, and a malformed journey does not', () => {
    const base = { id: 'o1', displayPrice: { amountMinor: 100, currency: 'USD' }, expiresAtUtc: '2026-11-30T12:00:00Z', segments: [segment()] };
    assert.equal(isOfferShape({ ...base, journeys: [[segment()], [segment({ origin: 'LHR', destination: 'DXB' })]] }), true);
    assert.equal(isOfferShape({ ...base, journeys: [[segment()], []] }), false);
    assert.equal(isOfferShape({ ...base, journeys: [] }), false);
  });

  test('journeysOfOffer uses journeys when present and falls back to segments', () => {
    const journeys = [[segment()], [segment()], [segment()]];
    assert.equal(journeysOfOffer({ segments: journeys[0], journeys }).length, 3);
    assert.equal(journeysOfOffer({ segments: [segment()], returnSegments: [segment()] }).length, 2);
    assert.equal(journeysOfOffer({ segments: [segment()] }).length, 1);
  });

  test('labels: return trips read Outbound and Return, multi-city reads Journey n of m', () => {
    assert.deepEqual(journeyLabels(2, 'round_trip'), ['Outbound', 'Return']);
    assert.deepEqual(journeyLabels(3, 'multi_city'), ['Journey 1 of 3', 'Journey 2 of 3', 'Journey 3 of 3']);
    assert.deepEqual(journeyLabels(2, 'multi_city'), ['Journey 1 of 2', 'Journey 2 of 2']);
  });
});

describe('build: the search origin in the Content-Security-Policy', () => {
  test('no endpoint means no origin, and a https endpoint gives its origin only', () => {
    assert.deepEqual(searchOriginFor(null), { origin: '' });
    assert.deepEqual(searchOriginFor(ENDPOINT), { origin: 'https://search.example.test' });
  });

  test('a production build refuses http, credentials and invalid URLs', () => {
    assert.ok(searchOriginFor('http://search.example.test/x').error);
    assert.ok(searchOriginFor('https://u:p@search.example.test/x').error);
    assert.ok(searchOriginFor('not a url').error);
  });

  test('connect-src accepts self, Supabase, the placeholder and one https origin', () => {
    const ok = `<meta content="default-src 'none'; connect-src 'self' https://*.supabase.co https://search.example.test;">`;
    assert.deepEqual(connectSrcProblems(ok), []);
    const placeholder = `<meta content="default-src 'none'; connect-src 'self' https://*.supabase.co ${SEARCH_PLACEHOLDER};">`;
    assert.deepEqual(connectSrcProblems(placeholder), []);
  });

  test('connect-src refuses wildcards, http, paths and other unexpected sources', () => {
    assert.ok(connectSrcProblems(`<meta content="connect-src *;">`).length > 0);
    assert.ok(connectSrcProblems(`<meta content="connect-src 'self' http://evil.example;">`).length > 0);
    assert.ok(connectSrcProblems(`<meta content="connect-src 'self' https://a.example/path;">`).length > 0);
    assert.ok(connectSrcProblems(`<meta content="default-src 'none';">`).length > 0);
  });
});
