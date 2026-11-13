// Fulfilment tests. Every supplier and payment provider here is a DEVELOPMENT FIXTURE.
// Passing these proves the state machine, idempotency and money-safety rules. It does NOT
// prove that Duffel or any airline behaves this way. Sandbox confirmation is still required.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FixtureOrderSupplier, type OrderKnobs } from '../src/fixture-orders.ts';
import { FulfilmentStore, type FulfilmentRecord } from '../src/store.ts';
import { placeOrder, pollTicketing, captureIfTicketed, cancelBooking, type FulfilmentDeps } from '../src/orchestrator.ts';
import { customerStatus, canMove, move, type FulfilmentStatus } from '../src/status.ts';
import { customerScreen } from '../src/customer-view.ts';
import { passengersFor, ticketsFor } from '../src/privacy.ts';
import { FixturePaymentProvider, FIXTURE_WEBHOOK_HEADER } from '../../payments/src/adapters/fixture.ts';
import { PaymentStore } from '../../payments/src/store.ts';
import { startPayment } from '../../payments/src/payment-flow.ts';
import { processWebhook } from '../../payments/src/webhook.ts';
import type { HoldPassenger } from '../../flights/src/supplier.ts';

const NOW = '2026-11-12T09:30:00Z';
const SECRET = 'fixture-secret';
const BOOKING = '0b0e3c3a-1111-4d2a-9f00-abcdef012345';

function passengers(adults: number): HoldPassenger[] {
  const names = ['Ada', 'Tunde', 'Ifeoma', 'Chidi'];
  return Array.from({ length: adults }, (_, i) => ({
    type: 'adult' as const, firstName: names[i], lastName: 'Okafor', dateOfBirth: '1990-05-14', nationality: 'NG',
  }));
}

// Builds a booking whose payment is authorised and whose fulfilment record is 'authorised'.
async function setup(knobs: OrderKnobs = {}, adults = 1, holdExpiresAtUtc = '2026-11-12T10:00:00Z') {
  const supplier = new FixtureOrderSupplier(knobs);
  const [offer] = await supplier.search({
    origin: 'LOS', destination: 'LHR', departureDate: '2026-12-01', passengers: adults, cabin: 'economy', displayCurrency: 'NGN',
  });
  const payments = new FixturePaymentProvider(SECRET);
  const payStore = new PaymentStore();
  const started = await startPayment(payStore, payments, supplier, {
    bookingId: BOOKING, holdId: 'hold_1', holdExpiresAtUtc, offer, totalMinor: offer.displayPrice.amountMinor,
    currency: 'NGN', customerEmail: 'ada@example.com',
  }, { productionEnabled: false }, NOW);
  assert.equal(started.status, 'initiated', JSON.stringify(started));
  const intent = payStore.getIntent(started.intentId)!;
  payments.setState(intent.providerRef!, 'authorised', intent.amount);
  const raw = JSON.stringify({ event: 'authorised', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'authorised' });
  await processWebhook(payStore, payments, raw, { [FIXTURE_WEBHOOK_HEADER]: payments.sign(raw) }, NOW);

  const store = new FulfilmentStore();
  store.create({
    bookingId: BOOKING, status: 'held', intentId: intent.id, offer, passengers: passengers(adults),
    totalMinor: offer.displayPrice.amountMinor, currency: 'NGN', holdExpiresAtUtc, orderId: null,
    bookingReference: null, documents: [], lockedReason: null, blockedReason: null,
  });
  store.transition(BOOKING, 'authorised', 'payment_authorised', NOW);
  const deps: FulfilmentDeps = { supplier, payments, payStore, store };
  return { deps, supplier, payments, payStore, store, intent, offer };
}

describe('state machine', () => {
  test("confirmed is reachable only after tickets are issued", () => {
    assert.equal(canMove('authorised', 'confirmed'), false, 'never straight from authorised');
    assert.equal(canMove('order_pending', 'confirmed'), false, 'never before tickets are issued');
    assert.equal(canMove('ticketed', 'confirmed'), true);
  });

  test('illegal moves throw and the state does not change', () => {
    assert.throws(() => move('refunded', 'confirmed'), RangeError);
    assert.throws(() => move('failed', 'ticketed'), RangeError);
  });

  test('customer copy never says confirmed unless the supplier confirmed', () => {
    const statuses: FulfilmentStatus[] = ['held', 'authorised', 'order_pending', 'ticketing_pending', 'ticketed', 'partially_fulfilled',
      'order_unknown', 'ticketing_unknown', 'failed', 'expired', 'cancellation_pending', 'cancelled', 'refund_pending', 'refunded'];
    for (const s of statuses) {
      assert.notEqual(customerStatus(s).headline, 'Booking confirmed', s);
      if (s !== "ticketed") assert.equal(customerStatus(s).showTickets, false, `no tickets shown while ${s}`);
    }
    assert.equal(customerStatus('confirmed').headline, 'Booking confirmed');
  });
});

describe('successful booking (fixture)', () => {
  test('order, pay the airline, read tickets back, then capture and confirm', async () => {
    const { deps, store, payStore, intent } = await setup();
    const rec = await placeOrder(deps, BOOKING, NOW);
    assert.equal(rec.status, 'ticketed');
    assert.equal(rec.documents.length, 1);
    assert.match(rec.documents[0].number, /^FX-/, 'fixture ticket numbers are obviously fake');

    const confirmed = await captureIfTicketed(deps, BOOKING, NOW);
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(payStore.getIntent(intent.id)?.status, 'captured');

    const screen = customerScreen(store.get(BOOKING)!);
    assert.equal(screen.status.headline, 'Booking confirmed');
    assert.equal(screen.tickets.length, 1);
    assert.equal(screen.tickets[0].number.startsWith('FX-'), true);
  });

  test('history records every change in order', async () => {
    const { deps, store } = await setup();
    await placeOrder(deps, BOOKING, NOW);
    await captureIfTicketed(deps, BOOKING, NOW);
    const steps = store.historyFor(BOOKING).map((h) => h.to);
    assert.deepEqual(steps, ['held', 'authorised', 'order_pending', 'ticketed', 'confirmed']);
  });
});

describe('delayed ticket issuance', () => {
  test('no capture and no confirmation while tickets are not yet issued', async () => {
    const { deps, store, payStore, intent } = await setup({ pollsBeforeTicketing: 2 });
    let rec = await placeOrder(deps, BOOKING, NOW);
    assert.equal(rec.status, 'ticketing_pending');

    const early = await captureIfTicketed(deps, BOOKING, NOW);
    assert.equal(early.status, 'ticketing_pending', 'capture is not attempted before tickets');
    assert.equal(payStore.getIntent(intent.id)?.status, 'authorised');
    assert.equal(customerScreen(store.get(BOOKING)!).tickets.length, 0);

    rec = await pollTicketing(deps, BOOKING, NOW);
    rec = await pollTicketing(deps, BOOKING, NOW);
    assert.equal(rec.status, 'ticketed');
    assert.equal((await captureIfTicketed(deps, BOOKING, NOW)).status, 'confirmed');
  });
});

describe('duplicate requests', () => {
  test('repeating the order step never creates or pays for a second order', async () => {
    const { deps, supplier } = await setup();
    await placeOrder(deps, BOOKING, NOW);
    await placeOrder(deps, BOOKING, NOW);
    await placeOrder(deps, BOOKING, NOW);
    assert.equal(supplier.orderCount(), 1);
    assert.equal(supplier.calls.filter((c) => c === 'create').length, 1);
    assert.equal(supplier.calls.filter((c) => c === 'pay').length, 1);
  });

  test('a repeated capture never captures twice', async () => {
    const { deps, payStore, intent } = await setup();
    await placeOrder(deps, BOOKING, NOW);
    await captureIfTicketed(deps, BOOKING, NOW);
    const again = await captureIfTicketed(deps, BOOKING, NOW);
    assert.equal(again.status, 'confirmed');
    assert.equal(payStore.getIntent(intent.id)?.capturedMinor, intent.amount.amountMinor);
  });
});

describe('supplier timeouts', () => {
  test('a lost reply after the order was created locks the booking and keeps the authorisation', async () => {
    const { deps, supplier, payStore, intent } = await setup({ timeoutOnCreateAfterCreating: true });
    const rec = await placeOrder(deps, BOOKING, NOW);
    assert.equal(rec.status, 'order_unknown');
    assert.match(rec.lockedReason ?? '', /Reconcile/);
    assert.equal(payStore.getIntent(intent.id)?.status, 'authorised', 'not released: an order may exist');
    assert.equal(supplier.orderCount(), 1, 'the order really exists in the fixture');
  });

  test('a locked booking is never re-ordered automatically', async () => {
    const { deps, supplier } = await setup({ timeoutOnCreateAfterCreating: true });
    await placeOrder(deps, BOOKING, NOW);
    await placeOrder(deps, BOOKING, NOW);
    assert.equal(supplier.calls.filter((c) => c === 'create').length, 1);
  });

  test('a lost reply after payment locks ticketing until the supplier confirms the payment', async () => {
    const { deps, supplier } = await setup({ timeoutOnPayAfterPaying: true });
    const rec = await placeOrder(deps, BOOKING, NOW);
    assert.equal(rec.status, 'ticketing_unknown');
    const polled = await pollTicketing(deps, BOOKING, NOW);
    assert.equal(polled.status, 'ticketed', 'supplier shows payment reached it, so tickets are read back');
    assert.equal(supplier.calls.filter((c) => c === 'pay').length, 1, 'never paid twice');
  });
});

describe('price changes and expiry before an order', () => {
  test('a fare change before the order fails the booking and releases the authorisation', async () => {
    const { deps, supplier, payStore, intent, offer } = await setup();
    const base = supplier.priceOffer.bind(supplier);
    supplier.priceOffer = async (o, now) => {
      const fresh = await base(o, now);
      return { ...fresh, supplierPrice: { amountMinor: fresh.supplierPrice.amountMinor + 1, currency: 'USD' } };
    };
    void offer;
    const rec = await placeOrder(deps, BOOKING, NOW);
    assert.equal(rec.status, 'failed');
    assert.equal(payStore.getIntent(intent.id)?.status, 'released');
    assert.equal(supplier.orderCount(), 0);
  });

  test('a hold that lapsed before ordering expires and releases the authorisation', async () => {
    const { deps, supplier, payStore, intent } = await setup({}, 1, '2026-11-12T10:00:00Z');
    const rec = await placeOrder(deps, BOOKING, '2026-11-12T11:00:00Z');
    assert.equal(rec.status, 'expired');
    assert.equal(payStore.getIntent(intent.id)?.status, 'released');
    assert.equal(supplier.orderCount(), 0);
  });

  test('an airline price change at payment cancels the unpaid order and releases funds', async () => {
    const { deps, supplier, payStore, intent } = await setup({ priceChangeOnPay: true });
    const rec = await placeOrder(deps, BOOKING, NOW);
    assert.equal(rec.status, 'failed');
    assert.equal(payStore.getIntent(intent.id)?.status, 'released');
    assert.ok(supplier.calls.includes('cancel'));
    assert.equal(supplier.calls.filter((c) => c === 'pay').length, 1, 'payment was refused, not retried');
  });
});

describe('partial failure', () => {
  test('some tickets issued but not all: partially fulfilled, no capture, no confirmation', async () => {
    const { deps, store, payStore, intent } = await setup({ ticketSeatsCovered: 'first_only' }, 2);
    const rec = await placeOrder(deps, BOOKING, NOW);
    assert.equal(rec.status, 'partially_fulfilled');
    assert.equal((await captureIfTicketed(deps, BOOKING, NOW)).status, 'partially_fulfilled');
    assert.equal(payStore.getIntent(intent.id)?.status, 'authorised');
    const screen = customerScreen(store.get(BOOKING)!);
    assert.equal(screen.status.headline, 'Some tickets are not yet issued');
    assert.equal(screen.tickets.length, 0);
  });
});

describe('cancellations', () => {
  test('cancelling a confirmed booking refunds the captured payment', async () => {
    const { deps, payStore, intent, store } = await setup();
    await placeOrder(deps, BOOKING, NOW);
    await captureIfTicketed(deps, BOOKING, NOW);
    const out = await cancelBooking(deps, BOOKING, NOW);
    assert.equal(out.status, 'refunded');
    assert.equal(payStore.getIntent(intent.id)?.status, 'refunded');
    assert.equal(payStore.getIntent(intent.id)?.refundedMinor, intent.amount.amountMinor);
    assert.equal(store.get(BOOKING)?.status, 'refunded');
  });

  test('cancelling before capture releases the authorisation instead of refunding', async () => {
    const { deps, payStore, intent } = await setup();
    await placeOrder(deps, BOOKING, NOW);
    const out = await cancelBooking(deps, BOOKING, NOW);
    assert.equal(out.status, 'cancelled');
    assert.equal(payStore.getIntent(intent.id)?.status, 'released');
  });

  test('a booking that was never ticketed cannot be cancelled through this path', async () => {
    const { deps } = await setup();
    await assert.rejects(cancelBooking(deps, BOOKING, NOW), RangeError);
  });
});

describe('privacy by role', () => {
  const sample: FulfilmentRecord = {
    bookingId: BOOKING, status: 'ticketed', intentId: 'x', offer: {} as never, passengers: passengers(1),
    totalMinor: 1, currency: 'NGN', holdExpiresAtUtc: NOW, orderId: 'o', bookingReference: 'R',
    documents: [{ type: 'electronic_ticket', number: 'FX-123456', passengerIndex: 0 }], lockedReason: null, blockedReason: null,
  };

  test('customers see names and full ticket numbers, not date of birth', () => {
    const p = passengersFor('customer', sample.passengers);
    assert.equal(p[0].name, 'Ada Okafor');
    assert.equal(p[0].dateOfBirth, undefined);
    assert.equal(ticketsFor('customer', sample.documents)[0].number, 'FX-123456');
  });

  test('support sees date of birth and nationality, but ticket numbers are masked', () => {
    assert.equal(passengersFor('support', sample.passengers)[0].dateOfBirth, '1990-05-14');
    assert.equal(ticketsFor('support', sample.documents)[0].number, '•••3456');
  });

  test('finance sees no personal details at all', () => {
    assert.deepEqual(passengersFor('finance', sample.passengers), []);
    assert.deepEqual(ticketsFor('finance', sample.documents), []);
  });

  test('the passenger model has no travel-document number field', () => {
    assert.equal(Object.keys(sample.passengers[0]).some((k) => /passport|document/i.test(k)), false);
  });
});

describe('screens never show tickets the supplier has not issued', () => {
  test('a ticketing_pending booking shows no tickets, even if documents were recorded', async () => {
    const { deps, store } = await setup({ pollsBeforeTicketing: 5 });
    await placeOrder(deps, BOOKING, NOW);
    store.patch(BOOKING, { documents: [{ type: 'electronic_ticket', number: 'FX-000001', passengerIndex: 0 }] });
    assert.equal(customerScreen(store.get(BOOKING)!).tickets.length, 0);
  });
});

describe('production ticketing gate', () => {
  test('production ticketing is refused without the owner gate and no order is created', async () => {
    const { deps, supplier } = await setup();
    const prodSupplier = Object.assign(Object.create(supplier), { mode: 'production' });
    const rec = await placeOrder({ ...deps, supplier: prodSupplier }, BOOKING, NOW);
    assert.equal(rec.status, 'authorised');
    assert.match(rec.blockedReason ?? '', /disabled/);
    assert.equal(supplier.orderCount(), 0);
  });
});
