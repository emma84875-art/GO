// Regression tests for the Phase 18.4 corrections: passenger types, currency handling, the Duffel timer,
// the sandbox token rule, and mixed-currency sorting. Duffel payloads here are SYNTHETIC fixtures.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DuffelFlightSupplier,
  buildDuffelOfferRequest,
  normaliseDuffelOffers,
  normaliseDuffelResult,
} from '../src/adapters/duffel.ts';
import { toSupplierRequest, type FlightSearchInput } from '../src/search.ts';
import { applyOfferFilters, sortOffers } from '../src/offer-filters.ts';
import { SupplierUnavailableError, type Offer, type SearchRequest, type Segment } from '../src/supplier.ts';
import type { FxRateSnapshot } from '../../core/src/pricing.ts';

const TODAY = '2026-11-24';
// A real segment, so the itinerary filters have something to read when a price limit is tested.
const SEG0: Segment = {
  origin: 'LOS', destination: 'LHR', carrier: 'AA', flightNumber: '1',
  departureUtc: '2026-12-01T07:00:00Z', arrivalUtc: '2026-12-01T13:00:00Z',
  departureTimeZone: 'Africa/Lagos', arrivalTimeZone: 'Europe/London',
};

const synthetic = {
  data: {
    offers: [
      {
        id: 'off_synthetic_1',
        total_amount: '1250.50',
        total_currency: 'USD',
        expires_at: '2026-11-30T12:00:00Z',
        slices: [
          {
            segments: [
              {
                departing_at: '2026-12-01T08:00:00',
                arriving_at: '2026-12-01T15:05:00',
                origin: { iata_code: 'LOS', time_zone: 'Africa/Lagos' },
                destination: { iata_code: 'LHR', time_zone: 'Europe/London' },
                marketing_carrier: { iata_code: 'XX' },
                marketing_carrier_flight_number: '100',
              },
            ],
          },
        ],
        passengers: [{ baggages: [{ type: 'checked', quantity: 1 }] }],
      },
    ],
  },
};

// A second synthetic offer in another currency, so one batch holds two currencies.
function twoCurrencyPayload(second: string) {
  const copy = structuredClone(synthetic);
  const extra = structuredClone(copy.data.offers[0]);
  extra.id = 'off_synthetic_2';
  extra.total_amount = '900.00';
  extra.total_currency = second;
  copy.data.offers.push(extra);
  return copy;
}

const baseRequest: SearchRequest = {
  origin: 'LOS',
  destination: 'LHR',
  departureDate: '2026-12-01',
  passengers: 1,
  cabin: 'economy',
  displayCurrency: 'NGN',
};

function typesOf(request: SearchRequest): string[] {
  const body = buildDuffelOfferRequest(request) as { data: { passengers: { type: string }[] } };
  return body.data.passengers.map((passenger) => passenger.type);
}

describe('passenger types reach the supplier separately', () => {
  test('adults, children and infants each keep their own type', () => {
    assert.deepEqual(
      typesOf({ ...baseRequest, passengers: 3, adults: 2, children: 1, infants: 1 }),
      ['adult', 'adult', 'child', 'infant_without_seat'],
    );
  });

  test('a child is never sent as an adult', () => {
    assert.deepEqual(typesOf({ ...baseRequest, passengers: 2, adults: 1, children: 1 }), ['adult', 'child']);
  });

  test('a request that gives only a passenger count still prices those passengers as adults', () => {
    assert.deepEqual(typesOf({ ...baseRequest, passengers: 2 }), ['adult', 'adult']);
  });

  test('the search contract keeps adult and child counts from the customer input to the supplier request', () => {
    const input: FlightSearchInput = {
      tripType: 'one_way',
      origin: 'LOS',
      destination: 'LHR',
      departureDate: '2026-12-01',
      passengers: { adults: 2, children: 3, infants: 1 },
      cabin: 'economy',
      displayCurrency: 'NGN',
    };
    const request = toSupplierRequest(input, TODAY);
    assert.equal(request.adults, 2);
    assert.equal(request.children, 3);
    assert.equal(request.passengers, 5, 'seat-occupying total is adults plus children');
    assert.equal(request.infants, 1);
  });
});

describe('currency: the supplier amount is never relabelled', () => {
  test('a stale FX snapshot is not used, and the amount keeps its supplier currency', () => {
    const stale: FxRateSnapshot = { from: 'USD', to: 'NGN', rateScaled: 1500_00000000n, capturedAtUtc: '2026-11-01T00:00:00Z' };
    const [offer] = normaliseDuffelOffers(synthetic, 'NGN', () => stale, { nowMs: Date.parse('2026-11-12T06:00:00Z') });
    assert.equal(offer.displayPrice.currency, 'USD');
    assert.equal(offer.displayPrice.amountMinor, 125050);
  });

  test('a snapshot for a different currency pair is ignored rather than applied', () => {
    const wrongPair: FxRateSnapshot = { from: 'GBP', to: 'NGN', rateScaled: 1900_00000000n, capturedAtUtc: '2026-11-12T05:00:00Z' };
    const [offer] = normaliseDuffelOffers(synthetic, 'NGN', () => wrongPair, { nowMs: Date.parse('2026-11-12T06:00:00Z') });
    assert.equal(offer.displayPrice.currency, 'USD');
    assert.equal(offer.displayPrice.amountMinor, 125050);
  });

  test('a snapshot with an unreadable capture time is not used', () => {
    const broken: FxRateSnapshot = { from: 'USD', to: 'NGN', rateScaled: 1500_00000000n, capturedAtUtc: 'not a time' };
    const [offer] = normaliseDuffelOffers(synthetic, 'NGN', () => broken, { nowMs: Date.parse('2026-11-12T06:00:00Z') });
    assert.equal(offer.displayPrice.currency, 'USD');
  });

  test('one offer that cannot be converted does not invalidate the rest of the batch', () => {
    const offers = normaliseDuffelOffers(twoCurrencyPayload('GBP'), 'NGN');
    assert.equal(offers.length, 2);
    assert.deepEqual(offers.map((offer) => offer.displayPrice.currency), ['USD', 'GBP']);
    assert.equal(offers[1].displayPrice.amountMinor, 90000);
    assert.equal(offers[1].supplierPrice.currency, 'GBP');
  });

  test('a price-sorted list groups currencies instead of comparing amounts across them', () => {
    const usd = { id: 'usd-cheap', displayPrice: { amountMinor: 100, currency: 'USD' }, segments: [SEG0] } as unknown as Offer;
    const gbp = { id: 'gbp-dear', displayPrice: { amountMinor: 900000, currency: 'GBP' }, segments: [SEG0] } as unknown as Offer;
    const ngn = { id: 'ngn-mid', displayPrice: { amountMinor: 5000, currency: 'NGN' }, segments: [SEG0] } as unknown as Offer;
    // Amounts alone would put the USD fare first. Grouping by currency code keeps each currency together:
    // GBP, then NGN, then USD (alphabetical), and amounts are compared only within one currency.
    const order = sortOffers([gbp, usd, ngn], 'price').map((offer) => offer.id);
    assert.deepEqual(order, ['gbp-dear', 'ngn-mid', 'usd-cheap']);
  });
});

describe('the Duffel timer covers reading the response body', () => {
  test('a body that is still arriving when the timer fires is reported as a timeout', async () => {
    const supplier = new DuffelFlightSupplier({
      mode: 'sandbox',
      accessToken: 'duffel_test_fixture',
      timeoutMs: 20,
      transport: async (_url, init) => ({
        status: 200,
        json: () => new Promise((resolve, reject) => {
          const pending = setTimeout(() => resolve(synthetic), 500);
          init.signal.addEventListener('abort', () => {
            clearTimeout(pending);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
      }),
    });
    await assert.rejects(
      supplier.search(baseRequest),
      (error: unknown) => error instanceof SupplierUnavailableError && error.reason === 'timeout',
    );
  });
});

describe('the sandbox token rule', () => {
  test('sandbox mode refuses a live token, and the error does not contain the token', () => {
    const live = 'duffel_live_not_a_real_token_789';
    assert.throws(
      () => new DuffelFlightSupplier({ mode: 'sandbox', accessToken: live }),
      (error: unknown) => error instanceof TypeError && !String(error.message).includes(live),
    );
  });

  test('sandbox mode accepts a test token', () => {
    assert.doesNotThrow(() => new DuffelFlightSupplier({ mode: 'sandbox', accessToken: 'duffel_test_fixture' }));
  });
});

describe('Phase 18.5: FX snapshots must match the exact pair', () => {
  const at = Date.parse('2026-11-12T06:00:00Z');
  const fresh = '2026-11-12T05:00:00Z';

  test('a snapshot whose destination is another currency is ignored, even when its source matches', () => {
    const toGbp: FxRateSnapshot = { from: 'USD', to: 'GBP', rateScaled: 80_00000000n, capturedAtUtc: fresh };
    const [offer] = normaliseDuffelOffers(synthetic, 'NGN', () => toGbp, { nowMs: at });
    assert.equal(offer.displayPrice.currency, 'USD', 'not labelled as GBP, and not as NGN');
    assert.equal(offer.displayPrice.amountMinor, 125050);
  });

  test('a reversed pair is ignored', () => {
    const reversed: FxRateSnapshot = { from: 'NGN', to: 'USD', rateScaled: 1_00000000n, capturedAtUtc: fresh };
    const [offer] = normaliseDuffelOffers(synthetic, 'NGN', () => reversed, { nowMs: at });
    assert.equal(offer.displayPrice.currency, 'USD');
  });

  test('the converter is asked only for the supplier currency to the requested currency', () => {
    const asked: string[] = [];
    normaliseDuffelOffers(synthetic, 'NGN', (from, to) => {
      asked.push(`${from}->${to}`);
      return undefined;
    }, { nowMs: at });
    assert.deepEqual(asked, ['USD->NGN']);
  });

  test('a snapshot is never requested when the offer is already in the requested currency', () => {
    const asked: string[] = [];
    normaliseDuffelOffers(synthetic, 'USD', (from, to) => {
      asked.push(`${from}->${to}`);
      return undefined;
    }, { nowMs: at });
    assert.deepEqual(asked, []);
  });
});

describe('Phase 18.5: Duffel currencies', () => {
  test('an offer in an unsupported currency is left out and the supported offers are kept', () => {
    const copy = structuredClone(synthetic);
    const extra = structuredClone(copy.data.offers[0]);
    extra.id = 'off_jpy';
    extra.total_currency = 'UYW';
    copy.data.offers.push(extra);
    const offers = normaliseDuffelOffers(copy, 'NGN');
    assert.deepEqual(offers.map((offer) => offer.id), ['off_synthetic_1']);
  });

  test('when every offer is in an unsupported currency, the result is empty with the reason counted, not an error', () => {
    const copy = structuredClone(synthetic);
    copy.data.offers[0].total_currency = 'UYW';
    const result = normaliseDuffelResult(copy, 'NGN');
    assert.equal(result.offers.length, 0);
    assert.deepEqual(result.excluded, { invalidCurrency: 1, currencies: ['UYW'], invalidPrice: 0, malformed: 0 });
  });

  test('a mixed batch reports each kind of exclusion and keeps the good offers', () => {
    const copy = structuredClone(synthetic);
    const base = copy.data.offers[0];
    const make = (id: string, fields: Record<string, unknown>) => ({ ...structuredClone(base), id, ...fields });
    copy.data.offers.push(
      make('off_iqd', { total_currency: 'UYW' }),
      make('off_iqd_2', { total_currency: 'UYW' }),
      make('off_irr', { total_currency: 'CLF' }),
      make('off_zero', { total_amount: '0.00' }),
      make('off_neg', { total_amount: '-5.00' }),
      make('off_text', { total_amount: 'abc' }),
      make('off_huge', { total_amount: '99999999999999999999.00' }),
    );
    const result = normaliseDuffelResult(copy, 'USD');
    assert.deepEqual(result.offers.map((offer) => offer.id), ['off_synthetic_1']);
    assert.deepEqual(result.excluded, { invalidCurrency: 3, currencies: ['CLF', 'UYW'], invalidPrice: 4, malformed: 0 });
  });

  test('a currency code that is not three capital letters is counted but never echoed', () => {
    const copy = structuredClone(synthetic);
    copy.data.offers[0].total_currency = '<script>';
    const result = normaliseDuffelResult(copy, 'USD');
    assert.deepEqual(result.excluded, { invalidCurrency: 1, currencies: [], invalidPrice: 0, malformed: 0 });
  });

  test('the supplier adapter reports the same exclusions through searchDetailed', async () => {
    const copy = structuredClone(synthetic);
    copy.data.offers[0].total_currency = 'UYW';
    const supplier = new DuffelFlightSupplier({
      mode: 'sandbox',
      accessToken: 'duffel_test_fixture',
      transport: async () => ({ status: 200, json: async () => copy }),
    });
    const result = await supplier.searchDetailed(baseRequest);
    assert.equal(result.offers.length, 0);
    assert.equal(result.excluded.invalidCurrency, 1);
  });
});

describe('Phase 18.5: sorting and price limits never compare currencies', () => {
  const usd = { id: 'usd', displayPrice: { amountMinor: 100, currency: 'USD' }, segments: [SEG0] } as unknown as Offer;
  const gbp = { id: 'gbp', displayPrice: { amountMinor: 900000, currency: 'GBP' }, segments: [SEG0] } as unknown as Offer;
  const ngn = { id: 'ngn', displayPrice: { amountMinor: 5000, currency: 'NGN' }, segments: [SEG0] } as unknown as Offer;

  test('with NGN preferred, NGN fares come first, then the other currencies in code order', () => {
    assert.deepEqual(sortOffers([usd, gbp, ngn], 'price', 'NGN').map((o) => o.id), ['ngn', 'gbp', 'usd']);
  });

  test('a price limit with no currency lets no offer through', () => {
    assert.deepEqual(applyOfferFilters([usd, ngn], { maxPriceMinor: 10_000_000 }).map((o) => o.id), []);
  });

  test('a price limit in one currency never admits an amount from another currency', () => {
    // 100 USD minor units is below the limit of 10,000, but it is not in NGN, so it is left out.
    assert.deepEqual(applyOfferFilters([usd, ngn], { maxPriceMinor: 10_000, maxPriceCurrency: 'NGN' }).map((o) => o.id), ['ngn']);
  });
});

describe('Phase 18.5: passengers through the search contract', () => {
  test('children and infants keep their counts from the input to the supplier request', () => {
    const request = toSupplierRequest({
      tripType: 'round_trip',
      origin: 'LOS',
      destination: 'LHR',
      departureDate: '2026-12-01',
      returnDate: '2026-12-10',
      passengers: { adults: 2, children: 2, infants: 2 },
      cabin: 'economy',
      displayCurrency: 'NGN',
    }, TODAY);
    assert.equal(request.adults, 2);
    assert.equal(request.children, 2);
    assert.equal(request.infants, 2);
    assert.equal(request.passengers, 4, 'infants do not occupy a seat');
    assert.deepEqual(typesOf(request), ['adult', 'adult', 'child', 'child', 'infant_without_seat', 'infant_without_seat']);
  });
});
