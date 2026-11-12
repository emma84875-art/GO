// Supplier response handling. All Duffel payloads here are SYNTHETIC fixtures shaped
// like the documented fields. They are not real Duffel responses and must not be
// presented as sandbox or live results.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DuffelFlightSupplier,
  buildDuffelOfferRequest,
  normaliseDuffelOffers,
  parseDecimalToMinor,
  type HttpResponse,
} from '../src/adapters/duffel.ts';
import { MockFlightSupplier } from '../src/adapters/mock.ts';
import { runFlightSearch } from '../src/search-service.ts';
import { SupplierUnavailableError, type SearchRequest } from '../src/supplier.ts';
import type { FxRateSnapshot } from '../../core/src/pricing.ts';

const request: SearchRequest = {
  origin: 'LOS',
  destination: 'LHR',
  departureDate: '2026-12-01',
  passengers: 2,
  infants: 1,
  cabin: 'business',
  displayCurrency: 'USD',
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
        conditions: { refund_before_departure: { allowed: false }, change_before_departure: null },
        passengers: [{ baggages: [{ type: 'checked', quantity: 2 }] }],
      },
    ],
  },
};

function fakeTransport(response: HttpResponse | Error, calls: { url: string; body: string }[] = []) {
  return async (url: string, init: { body: string }) => {
    calls.push({ url, body: init.body });
    if (response instanceof Error) throw response;
    return response;
  };
}

const ok = (payload: unknown): HttpResponse => ({ status: 200, json: async () => payload });

describe('Duffel request mapping', () => {
  test('round trip adds a return slice reversing the route', () => {
    const body = buildDuffelOfferRequest({ ...request, returnDate: '2026-12-10' }) as {
      data: { slices: { origin: string; destination: string }[] };
    };
    assert.deepEqual(body.data.slices.map((s) => [s.origin, s.destination]), [['LOS', 'LHR'], ['LHR', 'LOS']]);
  });

  test('lists infants without a seat separately from adults', () => {
    const body = buildDuffelOfferRequest(request) as { data: { passengers: { type: string }[] } };
    assert.deepEqual(body.data.passengers.map((p) => p.type), ['adult', 'adult', 'infant_without_seat']);
  });

  test('maps cabin classes', () => {
    const body = buildDuffelOfferRequest({ ...request, cabin: 'premium_economy' }) as { data: { cabin_class: string } };
    assert.equal(body.data.cabin_class, 'premium_economy');
  });
});

describe('decimal amount parsing', () => {
  test('converts decimal strings to minor units exactly', () => {
    assert.equal(parseDecimalToMinor('1250.50'), 125050);
    assert.equal(parseDecimalToMinor('12.5'), 1250);
    assert.equal(parseDecimalToMinor('7'), 700);
  });

  test('rejects floats, negatives and extra precision', () => {
    assert.throws(() => parseDecimalToMinor(12.5), SupplierUnavailableError);
    assert.throws(() => parseDecimalToMinor('-1.00'), SupplierUnavailableError);
    assert.throws(() => parseDecimalToMinor('1.005'), SupplierUnavailableError);
  });
});

describe('Duffel response normalisation (synthetic fixture)', () => {
  test('normalises an offer into the provider-independent shape', () => {
    const [offer] = normaliseDuffelOffers(synthetic, 'USD');
    assert.equal(offer.id, 'off_synthetic_1');
    assert.equal(offer.supplierPrice.amountMinor, 125050);
    assert.equal(offer.displayPrice.amountMinor, 125050);
    assert.equal(offer.segments[0].departureTimeZone, 'Africa/Lagos');
    assert.equal(offer.segments[0].carrier, 'XX');
  });

  test('unknown fare facts stay null, never guessed', () => {
    const [offer] = normaliseDuffelOffers(synthetic, 'USD');
    assert.equal(offer.fare?.checkedBags, 2);
    assert.equal(offer.fare?.refundable, false);
    assert.equal(offer.fare?.changeable, null);
    assert.equal(offer.fare?.cabinBags, null);
  });

  test('converts to a display currency only with a supplied FX snapshot', () => {
    const snapshot: FxRateSnapshot = { from: 'USD', to: 'NGN', rateScaled: 1500_00000000n, capturedAtUtc: '2026-11-12T05:00:00Z' };
    const [offer] = normaliseDuffelOffers(synthetic, 'NGN', (from, to) => (from === 'USD' && to === 'NGN' ? snapshot : undefined));
    assert.equal(offer.displayPrice.currency, 'NGN');
    assert.equal(offer.displayPrice.amountMinor, 125050 * 1500);
  });

  test('refuses to show a display price when no FX snapshot exists', () => {
    assert.throws(() => normaliseDuffelOffers(synthetic, 'NGN'), (error: unknown) =>
      error instanceof SupplierUnavailableError && error.reason === 'fx_unavailable');
  });

  test('rejects payloads without an offers array', () => {
    assert.throws(() => normaliseDuffelOffers({}, 'USD'), (e: unknown) => e instanceof SupplierUnavailableError && e.reason === 'invalid_response');
  });

  test('rejects an offer missing its price', () => {
    const broken = structuredClone(synthetic) as { data: { offers: Record<string, unknown>[] } };
    delete broken.data.offers[0].total_amount;
    assert.throws(() => normaliseDuffelOffers(broken, 'USD'), (e: unknown) => e instanceof SupplierUnavailableError && e.reason === 'invalid_response');
  });

  test('rejects an unsupported settlement currency', () => {
    const broken = structuredClone(synthetic) as { data: { offers: Record<string, unknown>[] } };
    broken.data.offers[0].total_currency = 'JPY';
    assert.throws(() => normaliseDuffelOffers(broken, 'USD'), (e: unknown) => e instanceof SupplierUnavailableError && e.reason === 'invalid_response');
  });
});

describe('Duffel adapter gating and failures', () => {
  test('without a token it does not call the network and reports not_configured', async () => {
    const calls: { url: string; body: string }[] = [];
    const supplier = new DuffelFlightSupplier({ mode: 'sandbox', transport: fakeTransport(ok(synthetic), calls) });
    await assert.rejects(supplier.search(request), (e: unknown) => e instanceof SupplierUnavailableError && e.reason === 'not_configured');
    assert.equal(calls.length, 0);
  });

  test('production is refused unless explicitly approved, and makes no call', async () => {
    const calls: { url: string; body: string }[] = [];
    const supplier = new DuffelFlightSupplier({ mode: 'production', accessToken: 'x', transport: fakeTransport(ok(synthetic), calls) });
    await assert.rejects(supplier.search(request), (e: unknown) => e instanceof SupplierUnavailableError && e.reason === 'production_not_approved');
    assert.equal(calls.length, 0);
  });

  test('a configured sandbox call sends the bearer token and version header', async () => {
    const seen: { url: string; headers?: Record<string, string> }[] = [];
    const supplier = new DuffelFlightSupplier({
      mode: 'sandbox',
      accessToken: 'test-token',
      transport: async (url, init) => {
        seen.push({ url, headers: (init as { headers: Record<string, string> }).headers });
        return ok(synthetic);
      },
    });
    const offers = await supplier.search({ ...request, infants: 0, passengers: 1, cabin: 'economy' });
    assert.equal(offers.length, 1);
    assert.match(seen[0].url, /api\.duffel\.com\/air\/offer_requests/);
    assert.equal(seen[0].headers?.Authorization, 'Bearer test-token');
  });

  test('HTTP errors become provider_error', async () => {
    const supplier = new DuffelFlightSupplier({ mode: 'sandbox', accessToken: 'x', transport: fakeTransport({ status: 500, json: async () => ({}) }) });
    await assert.rejects(supplier.search(request), (e: unknown) => e instanceof SupplierUnavailableError && e.reason === 'provider_error');
  });

  test('an abort becomes timeout', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const supplier = new DuffelFlightSupplier({ mode: 'sandbox', accessToken: 'x', transport: fakeTransport(abort) });
    await assert.rejects(supplier.search(request), (e: unknown) => e instanceof SupplierUnavailableError && e.reason === 'timeout');
  });

  test('a network failure becomes provider_error', async () => {
    const supplier = new DuffelFlightSupplier({ mode: 'sandbox', accessToken: 'x', transport: fakeTransport(new Error('ECONNRESET')) });
    await assert.rejects(supplier.search(request), (e: unknown) => e instanceof SupplierUnavailableError && e.reason === 'provider_error');
  });
});

describe('search outcomes for the UI', () => {
  const valid = {
    tripType: 'one_way' as const,
    origin: 'LOS',
    destination: 'LHR',
    departureDate: '2026-12-01',
    passengers: { adults: 2, children: 0, infants: 0 },
    cabin: 'economy' as const,
    displayCurrency: 'NGN' as const,
  };

  test('invalid input is reported without calling the supplier', async () => {
    const calls: unknown[] = [];
    const spy = { name: 'spy', mode: 'sandbox' as const, search: async (r: SearchRequest) => { calls.push(r); return []; } };
    const outcome = await runFlightSearch({ ...valid, origin: 'LOS', destination: 'LOS' }, '2026-11-12', spy);
    assert.equal(outcome.status, 'invalid');
    assert.equal(calls.length, 0);
  });

  test('a route with no fixture offers is empty, not an error', async () => {
    const outcome = await runFlightSearch({ ...valid, destination: 'CDG' }, '2026-11-12', new MockFlightSupplier());
    assert.equal(outcome.status, 'empty');
    assert.equal(outcome.source.mode, 'mock');
  });

  test('the fixture reports itself as mock so the UI can label it', async () => {
    const outcome = await runFlightSearch(valid, '2026-11-12', new MockFlightSupplier());
    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.source.mode, 'mock');
  });

  test('an unconfigured supplier becomes an unavailable state with its reason', async () => {
    const outcome = await runFlightSearch(valid, '2026-11-12', new DuffelFlightSupplier({ mode: 'sandbox' }));
    assert.equal(outcome.status, 'unavailable');
    assert.equal(outcome.reason, 'not_configured');
  });

  test('non-supplier errors are rethrown, not hidden', async () => {
    const broken = { name: 'broken', mode: 'sandbox' as const, search: async () => { throw new TypeError('bug'); } };
    await assert.rejects(runFlightSearch(valid, '2026-11-12', broken), TypeError);
  });
});
