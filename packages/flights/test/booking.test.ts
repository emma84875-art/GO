import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MockFlightSupplier } from '../src/adapters/mock.ts';
import { reserve } from '../src/reserve.ts';
import { buildBookingSummary } from '../src/booking-summary.ts';
import { SupplierUnavailableError, type FlightSupplier, type HoldPassenger, type Offer } from '../src/supplier.ts';
import { money } from '../../core/src/money.ts';

const NOW = '2026-11-12T09:30:00Z';
const KEY = 'booking:0b0e3c3a-1111-4d2a-9f00-abcdef012345:supplier_hold:1';

const passengers: HoldPassenger[] = [
  { type: 'adult', firstName: 'Ada', lastName: 'Okafor', dateOfBirth: '1990-05-14', nationality: 'NG' },
];

async function fixtureOffer(): Promise<Offer> {
  const [offer] = await new MockFlightSupplier().search({
    origin: 'LOS', destination: 'LHR', departureDate: '2026-12-01', passengers: 1, cabin: 'economy', displayCurrency: 'NGN',
  });
  return offer;
}

// A small supplier stub: each test chooses how the supplier behaves.
function stub(overrides: Partial<FlightSupplier> & { holds?: boolean }): FlightSupplier {
  return {
    name: 'stub',
    mode: 'sandbox',
    capabilities: { holds: overrides.holds ?? true },
    search: async () => [],
    priceOffer: overrides.priceOffer ?? (async (o: Offer) => o),
    createHold:
      overrides.createHold ??
      (async () => ({ holdId: "stub", status: "held" as const, expiresAtUtc: "2026-11-12T10:00:00Z" })),
  };
}

describe('reserve: happy path with the fixture', () => {
  test('places a hold that is pending, never confirmed or ticketed', async () => {
    const offer = await fixtureOffer();
    const outcome = await reserve(new MockFlightSupplier(), offer, passengers, NOW, { idempotencyKey: KEY });
    assert.equal(outcome.status, 'hold_placed');
    if (outcome.status !== 'hold_placed') return;
    assert.equal(outcome.bookingStatus, 'reservation_pending');
    assert.equal(outcome.ticketStatus, 'not_issued');
    assert.ok(Date.parse(outcome.expiresAtUtc) > Date.parse(NOW));
  });

  test('a retry with the same key returns the same hold (no duplicate)', async () => {
    const offer = await fixtureOffer();
    const supplier = new MockFlightSupplier();
    const first = await reserve(supplier, offer, passengers, NOW, { idempotencyKey: KEY });
    const second = await reserve(supplier, offer, passengers, NOW, { idempotencyKey: KEY });
    assert.deepEqual(first, second);
  });

  test('fixture hold ids are labelled as fixture ids', async () => {
    const offer = await fixtureOffer();
    const outcome = await reserve(new MockFlightSupplier(), offer, passengers, NOW, { idempotencyKey: KEY });
    assert.ok(outcome.status === 'hold_placed' && outcome.holdId.startsWith('fixture_'));
  });
});

describe('reserve: failure and edge outcomes', () => {
  test('a supplier without holds reports hold_unsupported and makes no hold', async () => {
    const offer = await fixtureOffer();
    const outcome = await reserve(stub({ holds: false }), offer, passengers, NOW, { idempotencyKey: KEY });
    assert.equal(outcome.status, 'hold_unsupported');
  });

  test('an expired offer is reported and no hold is attempted', async () => {
    const offer = await fixtureOffer();
    let held = false;
    const supplier = new MockFlightSupplier();
    const spy = stub({
      priceOffer: (o, now) => supplier.priceOffer(o, now),
      createHold: async () => { held = true; throw new Error('should not be called'); },
    });
    const outcome = await reserve(spy, offer, passengers, '2027-01-01T00:00:00Z', { idempotencyKey: KEY });
    assert.equal(outcome.status, 'offer_expired');
    assert.equal(held, false);
  });

  test('a price change is returned to the traveller and no hold is placed', async () => {
    const offer = await fixtureOffer();
    const repriced: Offer = { ...offer, supplierPrice: money(offer.supplierPrice.amountMinor + 1000, 'USD') };
    let held = false;
    const outcome = await reserve(
      stub({ priceOffer: async () => repriced, createHold: async () => { held = true; throw new Error('no'); } }),
      offer, passengers, NOW, { idempotencyKey: KEY },
    );
    assert.equal(outcome.status, 'fare_changed');
    assert.equal(held, false);
    assert.equal(outcome.status === 'fare_changed' && outcome.currentAmountMinor, repriced.supplierPrice.amountMinor);
  });

  test('a price change the traveller accepted proceeds to the hold', async () => {
    const offer = await fixtureOffer();
    const repriced: Offer = { ...offer, supplierPrice: money(offer.supplierPrice.amountMinor + 1000, 'USD') };
    const outcome = await reserve(
      stub({
        priceOffer: async () => repriced,
        createHold: async () => ({ holdId: 'h1', status: 'held', expiresAtUtc: '2026-11-12T10:00:00Z' }),
      }),
      offer, passengers, NOW, { idempotencyKey: KEY, acceptedAmountMinor: repriced.supplierPrice.amountMinor },
    );
    assert.equal(outcome.status, 'hold_placed');
  });

  test('a timeout on the hold is reported as UNKNOWN, never as failure', async () => {
    const offer = await fixtureOffer();
    const outcome = await reserve(
      stub({
        priceOffer: async (o) => o,
        createHold: async () => { throw new SupplierUnavailableError('timeout', 'slow'); },
      }),
      offer, passengers, NOW, { idempotencyKey: KEY },
    );
    assert.equal(outcome.status, 'hold_unknown');
    assert.match(outcome.status === 'hold_unknown' ? outcome.reconcileWith : '', /before retrying/);
  });

  test('a provider error on the hold is also unknown, because the hold may exist', async () => {
    const offer = await fixtureOffer();
    const outcome = await reserve(
      stub({ priceOffer: async (o) => o, createHold: async () => { throw new SupplierUnavailableError('provider_error', 'x'); } }),
      offer, passengers, NOW, { idempotencyKey: KEY },
    );
    assert.equal(outcome.status, 'hold_unknown');
  });

  test('a not-configured supplier is reported with its reason', async () => {
    const offer = await fixtureOffer();
    const outcome = await reserve(
      stub({ priceOffer: async () => { throw new SupplierUnavailableError('not_configured', 'no token'); } }),
      offer, passengers, NOW, { idempotencyKey: KEY },
    );
    assert.deepEqual(outcome, { status: 'supplier_unavailable', reason: 'not_configured', message: 'no token' });
  });

  test('a bug in the supplier is rethrown, not hidden', async () => {
    const offer = await fixtureOffer();
    await assert.rejects(
      reserve(stub({ priceOffer: async () => { throw new TypeError('bug'); } }), offer, passengers, NOW, { idempotencyKey: KEY }),
      TypeError,
    );
  });
});

describe('booking summary', () => {
  test('shows baggage, restrictions and fare conditions from the offer', async () => {
    const summary = buildBookingSummary(await fixtureOffer());
    assert.equal(summary.baggage.checked, '1 checked bag included');
    assert.equal(summary.refundable, 'No');
    assert.equal(summary.changeable, 'Yes');
    assert.equal(summary.restrictions.length, 1);
    assert.match(summary.restrictions[0], /placeholder/);
  });

  test('unknown facts are "not confirmed", never "none" or "included"', async () => {
    const offer = await fixtureOffer();
    const summary = buildBookingSummary({ ...offer, fare: { checkedBags: null, cabinBags: null, refundable: null, changeable: null, restrictions: [] } });
    assert.equal(summary.baggage.checked, 'Not confirmed by supplier');
    assert.equal(summary.refundable, 'Not confirmed by supplier');
  });

  test('taxes are never shown as included, and the total is explicit about it', async () => {
    const summary = buildBookingSummary(await fixtureOffer());
    assert.equal(summary.taxes, 'Not confirmed by supplier');
    assert.ok(summary.notes.some((n) => /Taxes are not included/.test(n)));
  });

  test('shows round-trip return segments separately', async () => {
    const [offer] = await new MockFlightSupplier().search({
      origin: 'LOS', destination: 'LHR', departureDate: '2026-12-01', returnDate: '2026-12-10', passengers: 1, cabin: 'economy', displayCurrency: 'NGN',
    });
    const summary = buildBookingSummary(offer);
    assert.equal(summary.outbound.length, 1);
    assert.equal(summary.inbound.length, 1);
    assert.equal(summary.inbound[0].from, 'LHR');
  });
});
