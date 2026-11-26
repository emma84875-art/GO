import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { validateSearch as sourceValidateSearch } from '../../../packages/flights/src/search.ts';
import { ROOT } from '../../../scripts/build-web.mjs';
import {
  inputFromParams,
  optionsFromParams,
  offerFiltersFrom,
  paramsFromInput,
  searchHash,
  todayInLagos,
  validateInput,
} from '../src/js/flight-logic.js';
import { createSearchSupplier, excludedFrom, isOfferShape, searchFlights, SEARCH_TIMEOUT_MS } from '../src/js/flight-client.js';
import {
  airlinesIn,
  baggageLines,
  buildResultCards,
  cardFor,
  conditionLines,
  priceNoteFor,
  dayOffset,
  localTime,
  stopsInfo,
} from '../src/js/flight-view.js';
import { accessFor, parseRoute } from '../src/js/routes.js';

const TODAY = '2026-11-24';
const LOS_ZONE = 'Africa/Lagos';
const LHR_ZONE = 'Europe/London';

const baseInput = {
  tripType: 'one_way',
  origin: 'LOS',
  destination: 'LHR',
  departureDate: '2026-12-01',
  passengers: { adults: 1, children: 0, infants: 0 },
  cabin: 'economy',
  displayCurrency: 'NGN',
};

// Synthetic offers for TESTS ONLY. They are not shipped and never reach the browser bundle.
function segment(fields) {
  return {
    carrier: 'TT',
    flightNumber: '100',
    departureTimeZone: LOS_ZONE,
    arrivalTimeZone: LHR_ZONE,
    ...fields,
  };
}

function offer({ id, amount, segments, fare, returnSegments }) {
  return {
    id,
    supplierPrice: { amountMinor: amount, currency: 'NGN' },
    displayPrice: { amountMinor: amount, currency: 'NGN' },
    expiresAtUtc: '2026-11-30T12:00:00Z',
    segments,
    ...(fare ? { fare } : {}),
    ...(returnSegments ? { returnSegments } : {}),
  };
}

const NONSTOP = offer({
  id: 'nonstop',
  amount: 900000,
  segments: [segment({ origin: 'LOS', destination: 'LHR', carrier: 'AA', flightNumber: '101', departureUtc: '2026-12-01T08:00:00Z', arrivalUtc: '2026-12-01T15:05:00Z' })],
  fare: { checkedBags: 1, cabinBags: null, refundable: false, changeable: true, restrictions: ['Name change not allowed'] },
});

const ONE_STOP = offer({
  id: 'one-stop',
  amount: 700000,
  segments: [
    segment({ origin: 'LOS', destination: 'ACC', carrier: 'BB', flightNumber: '202', departureUtc: '2026-12-01T20:00:00Z', arrivalUtc: '2026-12-01T21:00:00Z', arrivalTimeZone: 'Africa/Accra' }),
    segment({ origin: 'ACC', destination: 'LHR', carrier: 'BB', flightNumber: '203', departureUtc: '2026-12-01T23:00:00Z', arrivalUtc: '2026-12-02T06:30:00Z', departureTimeZone: 'Africa/Accra' }),
  ],
  fare: null,
});

describe('search parameters', () => {
  test('a round trip keeps its return date through the URL', () => {
    const input = inputFromParams({ trip: 'round_trip', from: 'los', to: 'lhr', depart: '2026-12-01', return: '2026-12-10', adults: '2', children: '1', infants: '0', cabin: 'business', currency: 'USD' });
    assert.equal(input.origin, 'LOS');
    assert.equal(input.returnDate, '2026-12-10');
    assert.deepEqual(input.passengers, { adults: 2, children: 1, infants: 0 });
    assert.deepEqual(validateInput(input, TODAY), {});
    const back = inputFromParams(Object.fromEntries(paramsFromInput(input)));
    assert.deepEqual(back, input);
  });

  test('a one-way search ignores any return date', () => {
    const input = inputFromParams({ trip: 'one_way', from: 'LOS', to: 'LHR', depart: '2026-12-01', return: '2026-12-10' });
    assert.equal('returnDate' in input, false);
    assert.deepEqual(validateInput(input, TODAY), {});
  });

  test('missing airports and dates produce clear messages, keyed by field', () => {
    const errors = validateInput(inputFromParams({}), TODAY);
    assert.equal(errors.origin, 'Choose a departure airport.');
    assert.equal(errors.destination, 'Choose a destination airport.');
    assert.equal(errors.departureDate, 'Enter a valid departure date.');
  });

  test('passenger counts must be whole numbers, and infants need an adult', () => {
    assert.match(validateInput(inputFromParams({ from: 'LOS', to: 'LHR', depart: '2026-12-01', adults: '1.5' }), TODAY).passengers, /whole numbers/);
    assert.match(validateInput(inputFromParams({ from: 'LOS', to: 'LHR', depart: '2026-12-01', adults: '1', infants: '2' }), TODAY).passengers, /Each infant needs an adult/);
    assert.match(validateInput(inputFromParams({ from: 'LOS', to: 'LHR', depart: '2026-12-01', adults: '0' }), TODAY).passengers, /At least one adult/);
  });

  test('the browser validator gives the same answers as the server validator', () => {
    const cases = [
      baseInput,
      { ...baseInput, destination: 'LOS' },
      { ...baseInput, departureDate: '2026-11-01' },
      { ...baseInput, departureDate: '2026-02-30' },
      { ...baseInput, tripType: 'round_trip', returnDate: '2026-11-30' },
      { ...baseInput, tripType: 'one_way', returnDate: '2026-12-10' },
      { ...baseInput, passengers: { adults: 5, children: 5, infants: 0 } },
      { ...baseInput, cabin: 'couch' },
      { ...baseInput, displayCurrency: 'JPY' },
    ];
    for (const input of cases) {
      assert.deepEqual(validateInput(input, TODAY), sourceValidateSearch(input, TODAY).errors, JSON.stringify(input));
    }
  });

  test('today is a YYYY-MM-DD date in Lagos', () => {
    assert.match(todayInLagos(), /^\d{4}-\d{2}-\d{2}$/);
    // 23:30 UTC on 30 Nov is already 1 December in Lagos (UTC+1).
    assert.equal(todayInLagos(new Date('2026-11-30T23:30:00Z')), '2026-12-01');
  });

  test('result options fall back to safe defaults for unknown values', () => {
    assert.deepEqual(optionsFromParams({ sort: 'cheapest-ever', stops: 'many', dep: 'midnight', airline: '<script>', bags: '0' }), {
      sort: 'price',
      stops: 'any',
      departure: 'any',
      airline: '',
      checkedBags: false,
    });
    assert.deepEqual(offerFiltersFrom(optionsFromParams({ stops: 'nonstop', dep: 'morning', airline: 'aa', bags: '1' })), {
      stops: 'nonstop',
      airlines: ['AA'],
      departureFromMinutes: 0,
      departureToMinutes: 719,
      requireCheckedBags: true,
    });
  });

  test('a changed search link drops empty values and keeps the rest', () => {
    const hash = searchHash({ trip: 'one_way', from: 'LOS', to: 'LHR', depart: '2026-12-01', sort: 'price' }, { sort: 'duration', stops: '' });
    assert.equal(hash, '#/search?trip=one_way&from=LOS&to=LHR&depart=2026-12-01&sort=duration');
  });
});

describe('search client', () => {
  test('with no endpoint configured, no request is made and the result is unavailable', async () => {
    let calls = 0;
    const outcome = await searchFlights(baseInput, TODAY, { endpoint: null, fetchImpl: async () => { calls += 1; } });
    assert.equal(calls, 0);
    assert.equal(outcome.status, 'unavailable');
    assert.equal(outcome.reason, 'not_configured');
  });

  test('an invalid search never reaches the network', async () => {
    let calls = 0;
    const outcome = await searchFlights({ ...baseInput, destination: 'LOS' }, TODAY, {
      endpoint: 'https://search.example.test/api/flights/search',
      fetchImpl: async () => { calls += 1; },
    });
    assert.equal(outcome.status, 'invalid');
    assert.equal(calls, 0);
  });

  test('a successful response becomes ok, with only the validated fields in the request', async () => {
    let sent;
    const outcome = await searchFlights(baseInput, TODAY, {
      endpoint: 'https://search.example.test/api/flights/search',
      mode: 'sandbox',
      fetchImpl: async (url, init) => {
        sent = { url, init };
        return { ok: true, status: 200, json: async () => ({ offers: [NONSTOP, ONE_STOP] }) };
      },
    });
    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.offers.length, 2);
    assert.equal(outcome.source.mode, 'sandbox');
    assert.equal(sent.url, 'https://search.example.test/api/flights/search');
    assert.equal(sent.init.credentials, 'omit');
    assert.equal(sent.init.headers.Authorization, undefined);
    const body = JSON.parse(sent.init.body);
    assert.equal(body.origin, 'LOS');
    assert.equal(body.destination, 'LHR');
  });

  test('an empty list is the empty state, not an error', async () => {
    const outcome = await searchFlights(baseInput, TODAY, {
      endpoint: 'https://search.example.test/api/flights/search',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ offers: [] }) }),
    });
    assert.equal(outcome.status, 'empty');
  });

  test('supplier errors become unavailable states with a reason, never a fake result', async () => {
    const serverError = await searchFlights(baseInput, TODAY, {
      endpoint: 'https://search.example.test/api/x',
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    assert.equal(serverError.status, 'unavailable');
    assert.equal(serverError.reason, 'provider_error');

    const notJson = await searchFlights(baseInput, TODAY, {
      endpoint: 'https://search.example.test/api/x',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }),
    });
    assert.equal(notJson.reason, 'invalid_response');

    const timedOut = await searchFlights(baseInput, TODAY, {
      endpoint: 'https://search.example.test/api/x',
      timeoutMs: 5,
      fetchImpl: (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    });
    assert.equal(timedOut.reason, 'timeout');
  });

  test('malformed offers are counted and skipped; a response of only malformed offers is still answered', async () => {
    const mixed = await searchFlights(baseInput, TODAY, {
      endpoint: 'https://search.example.test/api/x',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ offers: [NONSTOP, { id: 'broken' }] }) }),
    });
    assert.equal(mixed.status, 'ok');
    assert.equal(mixed.offers.length, 1);

    const allBroken = await searchFlights(baseInput, TODAY, {
      endpoint: 'https://search.example.test/api/x',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ offers: [{ id: 'broken' }] }) }),
    });
    assert.equal(allBroken.status, 'empty');
    assert.equal(allBroken.excluded.malformed, 1);
  });

  test('offer shape checks reject impossible times and prices', () => {
    assert.equal(isOfferShape(NONSTOP), true);
    assert.equal(isOfferShape({ ...NONSTOP, displayPrice: { amountMinor: 1.5, currency: 'NGN' } }), false);
    assert.equal(isOfferShape({ ...NONSTOP, expiresAtUtc: 'soon' }), false);
    assert.equal(isOfferShape({ ...NONSTOP, segments: [{ ...NONSTOP.segments[0], departureUtc: 'later' }] }), false);
  });

  test('the supplier object has no booking capability in the browser', () => {
    const supplier = createSearchSupplier({ endpoint: null });
    assert.equal(supplier.capabilities.holds, false);
    assert.equal(typeof supplier.createHold, 'undefined');
  });
});

describe('result rules', () => {
  test('stops name the connection airports', () => {
    assert.deepEqual(stopsInfo(NONSTOP.segments), { count: 0, text: 'Nonstop' });
    assert.equal(stopsInfo(ONE_STOP.segments).text, '1 stop in Accra (ACC)');
  });

  test('an unconfirmed baggage or condition detail is never shown as none', () => {
    assert.deepEqual(baggageLines(null), ['Checked bags: not confirmed by the airline', 'Cabin bag: not confirmed by the airline']);
    const lines = baggageLines({ checkedBags: null, cabinBags: 0, refundable: null, changeable: null, restrictions: [] });
    assert.equal(lines[0], 'Checked bags: not confirmed by the airline');
    assert.equal(lines[1], 'No cabin bag included');
    assert.deepEqual(conditionLines(null), ['Refund and change terms not confirmed by the airline']);
    const conditions = conditionLines({ checkedBags: 1, cabinBags: null, refundable: null, changeable: false, restrictions: ['Name change not allowed'] });
    assert.equal(conditions[0], 'Refund terms not confirmed by the airline');
    assert.equal(conditions[1], 'Changes not allowed before departure');
    assert.equal(conditions[2], 'Name change not allowed');
  });

  test('times are shown in each airport’s local time and arrivals on a later day are marked', () => {
    assert.equal(localTime('2026-12-01T08:00:00Z', LOS_ZONE), '09:00');
    assert.equal(localTime('2026-12-01T08:00:00Z', LHR_ZONE), '08:00');
    assert.equal(dayOffset('2026-12-01T23:00:00Z', 'Africa/Accra', '2026-12-02T06:30:00Z', LHR_ZONE), 1);
    const card = buildResultCards([ONE_STOP], { sort: 'price', stops: 'any', departure: 'any', airline: '', checkedBags: false }).cards[0];
    assert.equal(card.journeys[0].view.to.dayOffset, 1);
  });

  test('sorting, stops, airline, bags and departure window filter and order the results', () => {
    const all = [NONSTOP, ONE_STOP];
    const base = { sort: 'price', stops: 'any', departure: 'any', airline: '', checkedBags: false };
    assert.deepEqual(buildResultCards(all, base).cards.map((card) => card.id), ['one-stop', 'nonstop']);
    assert.deepEqual(buildResultCards(all, { ...base, sort: 'duration' }).cards.map((card) => card.id), ['nonstop', 'one-stop']);
    assert.deepEqual(buildResultCards(all, { ...base, stops: 'nonstop' }).cards.map((card) => card.id), ['nonstop']);
    assert.deepEqual(buildResultCards(all, { ...base, airline: 'BB' }).cards.map((card) => card.id), ['one-stop']);
    assert.deepEqual(buildResultCards(all, { ...base, checkedBags: true }).cards.map((card) => card.id), ['nonstop']);
    assert.deepEqual(buildResultCards(all, { ...base, departure: 'morning' }).cards.map((card) => card.id), ['nonstop']);
    assert.deepEqual(buildResultCards(all, { ...base, departure: 'evening' }).cards.map((card) => card.id), ['one-stop']);
    const none = buildResultCards(all, { ...base, airline: 'ZZ' });
    assert.equal(none.shown, 0);
    assert.equal(none.total, 2);
  });

  test('the airline filter lists only carriers present in the results', () => {
    assert.deepEqual(airlinesIn([ONE_STOP, NONSTOP]), ['AA', 'BB']);
  });

  test('a return journey is shown as its own leg', () => {
    const roundTrip = offer({
      id: 'rt',
      amount: 1200000,
      segments: NONSTOP.segments,
      returnSegments: [segment({ origin: 'LHR', destination: 'LOS', carrier: 'AA', flightNumber: '102', departureTimeZone: LHR_ZONE, arrivalTimeZone: LOS_ZONE, departureUtc: '2026-12-10T10:00:00Z', arrivalUtc: '2026-12-10T17:05:00Z' })],
    });
    const card = buildResultCards([roundTrip], { sort: 'price', stops: 'any', departure: 'any', airline: '', checkedBags: false }).cards[0];
    assert.equal(card.journeys.length, 2);
    assert.equal(card.journeys[1].view.from.airport, 'London (LHR)');
  });
});

describe('route and vendored code', () => {
  test('the search page is public and reads its parameters from the hash', () => {
    const route = parseRoute('#/search?from=LOS&to=LHR');
    assert.equal(route.name, 'search');
    assert.equal(route.params.from, 'LOS');
    assert.deepEqual(accessFor(route, null), { action: 'show' });
  });

  test('no supplier adapter is copied into the browser source', () => {
    assert.equal(existsSync(join(ROOT, 'apps', 'web', 'src', 'vendor', 'packages', 'flights', 'src', 'adapters')), false);
    assert.equal(existsSync(join(ROOT, 'apps', 'web', 'src', 'vendor', 'packages', 'flights', 'src', 'adapters', 'mock.js')), false);
  });
});

describe('Phase 18.4 browser corrections', () => {
  test('the browser waits longer than the service supplier timeout and a free-plan wake-up', () => {
    assert.ok(SEARCH_TIMEOUT_MS >= 60000, 'at least 60 seconds');
  });

  test('airline choices come from every journey, including the return', () => {
    const trip = offer({
      id: 'trip',
      amount: 100000,
      segments: [segment({ origin: 'LOS', destination: 'LHR', carrier: 'AA', flightNumber: '1', departureUtc: '2026-12-01T08:00:00Z', arrivalUtc: '2026-12-01T15:00:00Z' })],
      returnSegments: [segment({ origin: 'LHR', destination: 'LOS', carrier: 'BA', flightNumber: '2', departureUtc: '2026-12-10T08:00:00Z', arrivalUtc: '2026-12-10T18:00:00Z', departureTimeZone: LHR_ZONE, arrivalTimeZone: LOS_ZONE })],
    });
    assert.deepEqual(airlinesIn([trip]), ['AA', 'BA']);
  });

  test('choosing a carrier that flies only the return keeps the trip', () => {
    const trip = offer({
      id: 'trip',
      amount: 100000,
      segments: [segment({ origin: 'LOS', destination: 'LHR', carrier: 'AA', departureUtc: '2026-12-01T08:00:00Z', arrivalUtc: '2026-12-01T15:00:00Z' })],
      returnSegments: [segment({ origin: 'LHR', destination: 'LOS', carrier: 'BA', departureUtc: '2026-12-10T08:00:00Z', arrivalUtc: '2026-12-10T18:00:00Z', departureTimeZone: LHR_ZONE, arrivalTimeZone: LOS_ZONE })],
    });
    const model = buildResultCards([trip], { ...optionsFromParams({}), airline: 'BA' }, 'round_trip', 'NGN');
    assert.equal(model.shown, 1);
  });

  test('a fare in another currency is labelled with its own currency and a not-converted note', () => {
    const usd = { ...NONSTOP, id: 'usd', displayPrice: { amountMinor: 50000, currency: 'USD' } };
    const card = cardFor(usd, 'one_way', 'NGN');
    assert.match(card.price, /US\$|USD/);
    assert.match(card.priceNote, /Shown in USD/);
    assert.match(card.priceNote, /has not converted it to NGN/);
  });

  test('a fare in the requested currency has no note', () => {
    assert.equal(cardFor(NONSTOP, 'one_way', 'NGN').priceNote, null);
  });

  test('mixed currencies are grouped in price order, never compared as amounts', () => {
    const usd = { ...NONSTOP, id: 'usd-cheap', displayPrice: { amountMinor: 100, currency: 'USD' } };
    const model = buildResultCards([usd, NONSTOP], { ...optionsFromParams({}), sort: 'price' }, 'one_way', 'NGN');
    assert.deepEqual(model.cards.map((card) => card.id), ['nonstop', 'usd-cheap']);
  });
});

describe('Phase 18.5 currency display', () => {
  test('a fare converted from the airline currency says what it was converted from', () => {
    const converted = { ...NONSTOP, displayPrice: { amountMinor: 900000, currency: 'NGN' }, supplierPrice: { amountMinor: 600, currency: 'USD' } };
    assert.equal(priceNoteFor(converted, 'NGN'), "Converted from the airline's fare in USD at a GO exchange rate.");
  });

  test('a fare in the requested currency with no conversion has no note', () => {
    assert.equal(priceNoteFor(NONSTOP, 'NGN'), null);
  });

  test('NGN fares are listed first when NGN is requested, then other currencies in code order', () => {
    const usd = { ...NONSTOP, id: 'usd', displayPrice: { amountMinor: 100, currency: 'USD' } };
    const gbp = { ...NONSTOP, id: 'gbp', displayPrice: { amountMinor: 900000, currency: 'GBP' } };
    const model = buildResultCards([usd, gbp, NONSTOP], { ...optionsFromParams({}), sort: 'price' }, 'one_way', 'NGN');
    assert.deepEqual(model.cards.map((card) => card.id), ['nonstop', 'gbp', 'usd']);
  });
});

describe('Phase 18.6 transparency and staging rules', () => {
  test('excluded counts are read only when they are valid; malformed values count as none', () => {
    assert.deepEqual(excludedFrom({ invalidCurrency: 2, currencies: ['JPY', '<b>x</b>', 'AED'], invalidPrice: 1, malformed: 0 }), {
      invalidCurrency: 2,
      currencies: ['JPY', 'AED'],
      invalidPrice: 1, malformed: 0,
    });
    assert.deepEqual(excludedFrom({ invalidCurrency: -1, currencies: 'JPY', invalidPrice: 1.5 }), {
      invalidCurrency: 0,
      currencies: [],
      invalidPrice: 0, malformed: 0,
    });
    assert.deepEqual(excludedFrom(undefined), { invalidCurrency: 0, currencies: [], invalidPrice: 0, malformed: 0 });
  });

  test('a zero price is never shown as a fare', () => {
    assert.equal(isOfferShape({ ...NONSTOP, displayPrice: { amountMinor: 0, currency: 'NGN' } }), false);
    assert.equal(isOfferShape({ ...NONSTOP, displayPrice: { amountMinor: -100, currency: 'NGN' } }), false);
  });

  test('results in more than one currency are flagged, so the page can warn against comparing them', () => {
    const usd = { ...NONSTOP, id: 'usd', displayPrice: { amountMinor: 100, currency: 'USD' } };
    assert.equal(buildResultCards([NONSTOP, usd], optionsFromParams({}), 'one_way', 'NGN').mixedCurrencies, true);
    assert.equal(buildResultCards([NONSTOP], optionsFromParams({}), 'one_way', 'NGN').mixedCurrencies, false);
  });

  test('every card names its fare currency', () => {
    assert.equal(cardFor(NONSTOP, 'one_way', 'NGN').currencyCode, 'NGN');
  });

  test('the naira price keeps two decimal places and shows the ISO code, not a symbol', () => {
    const card = cardFor({ ...NONSTOP, displayPrice: { amountMinor: 123456789, currency: 'NGN' } }, 'one_way', 'NGN');
    assert.equal(card.price, 'NGN 1,234,567.89');
  });
});

