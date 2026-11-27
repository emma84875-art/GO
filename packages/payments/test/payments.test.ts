// Payment architecture tests. The fixture provider is a DEVELOPMENT FIXTURE. Passing these
// tests proves the state machine and safety rules, not that any real provider works.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FixturePaymentProvider, FIXTURE_WEBHOOK_HEADER } from '../src/adapters/fixture.ts';
import { PaystackPaymentProvider, PAYSTACK_SIGNATURE_HEADER, requirePaystackRedirect } from '../src/adapters/paystack.ts';
import { FlutterwavePaymentProvider, FLUTTERWAVE_HASH_HEADER } from '../src/adapters/flutterwave.ts';
import { PaymentStore } from '../src/store.ts';
import { startPayment, captureAfterFulfilment, releaseAfterSupplierFailure, refund, expireStaleIntents, type PaymentBooking } from '../src/payment-flow.ts';
import { processWebhook } from '../src/webhook.ts';
import type { InitiateRequest } from '../src/provider.ts';
import { reconcile } from '../src/reconcile.ts';
import { canTransition, transition } from '../src/state.ts';
import { MockFlightSupplier } from '../../flights/src/adapters/mock.ts';
import type { Actor } from '../../auth/src/actor.ts';

// Test identities. Services act through the payments and fulfilment paths; users are tested separately.
const PAY: Actor = { kind: 'system', service: 'payments' };
const FUL: Actor = { kind: 'system', service: 'fulfilment' };
import { SupplierUnavailableError, type FlightSupplier, type Offer } from '../../flights/src/supplier.ts';
import { createHash, createHmac } from 'node:crypto';
import { BOOKING_PAYMENT_PROVIDERS } from '../src/payment-flow.ts';

const NOW = '2026-11-12T09:30:00Z';
const HOLD_EXPIRY = '2026-11-12T10:00:00Z';
const SECRET = 'fixture-secret';

async function fixtureOffer(): Promise<Offer> {
  const [offer] = await new MockFlightSupplier().search({
    origin: 'LOS', destination: 'LHR', departureDate: '2026-12-01', passengers: 1, cabin: 'economy', displayCurrency: 'NGN',
  });
  return offer;
}

async function bookingFor(overrides: Partial<PaymentBooking> = {}): Promise<PaymentBooking> {
  const offer = await fixtureOffer();
  return {
    bookingId: '0b0e3c3a-1111-4d2a-9f00-abcdef012345',
    holdId: 'hold_1',
    holdExpiresAtUtc: HOLD_EXPIRY,
    offer,
    totalMinor: offer.displayPrice.amountMinor,
    currency: 'NGN',
    customerEmail: 'ada@example.com',
    ...overrides,
  };
}

function signedWebhook(provider: FixturePaymentProvider, body: Record<string, unknown>) {
  // Every fixture event has a provider event id. The same body always gets the same id, so a resend is a duplicate.
  const withId = { id: createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16), ...body };
  const raw = JSON.stringify(withId);
  return { raw, headers: { [FIXTURE_WEBHOOK_HEADER]: provider.sign(raw) } };
}

// Starts a payment and returns the pieces the tests need.
async function started(overrides: Partial<PaymentBooking> = {}, supplier: FlightSupplier = new MockFlightSupplier()) {
  const store = new PaymentStore();
  const provider = new FixturePaymentProvider(SECRET);
  const booking = await bookingFor(overrides);
  const outcome = await startPayment(store, PAY, provider, supplier, booking, { productionEnabled: false }, NOW);
  assert.equal(outcome.status, 'initiated', JSON.stringify(outcome));
  const intent = store.getIntent(outcome.intentId);
  assert.ok(intent);
  return { store, provider, booking, intent, supplier };
}

describe('payment state machine', () => {
  test('allows the documented path and refuses skips', () => {
    assert.equal(canTransition('initiated', 'authorised'), true);
    assert.equal(canTransition('authorised', 'capture_requested'), true);
    assert.equal(canTransition('capture_requested', 'captured'), true);
    // captured is reachable only from capture_requested: no request, no capture.
    assert.equal(canTransition('authorised', 'captured'), false);
    assert.equal(canTransition('initiated', 'captured'), false);
    assert.equal(canTransition('review_required', 'captured'), false);
    assert.equal(canTransition('refunded', 'captured'), false);
    assert.equal(canTransition('failed', 'captured'), false);
    assert.throws(() => transition('failed', 'captured'), RangeError);
  });
});

describe('successful payment (fixture)', () => {
  test('authorise, verify by webhook, capture after confirmed fulfilment, then refund', async () => {
    const { store, provider, intent } = await started();
    provider.setState(intent.providerRef!, 'authorised', intent.amount);

    const hook = signedWebhook(provider, { event: 'authorised', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'authorised' });
    const applied = await processWebhook(store, provider, hook.raw, hook.headers, NOW);
    assert.deepEqual(applied, { status: 'applied', intentId: intent.id, to: 'authorised' });

    const captured = await captureAfterFulfilment(store, FUL, provider, intent.id, 'verified', intent.amount.amountMinor, 'NGN', NOW);
    assert.equal(captured.status, 'captured');
    assert.equal(store.getIntent(intent.id)?.capturedMinor, intent.amount.amountMinor);

    const partial = await refund(store, FUL, provider, intent.id, 1000, NOW);
    assert.equal(partial.status, 'partially_refunded');
    const rest = await refund(store, FUL, provider, intent.id, intent.amount.amountMinor - 1000, NOW);
    assert.equal(rest.status, 'refunded');
    assert.equal(store.getIntent(intent.id)?.status, 'refunded');
  });
});

describe('failed payment (fixture)', () => {
  test('a failed webhook moves the intent to failed, and it can never be captured', async () => {
    const { store, provider, intent } = await started();
    provider.setState(intent.providerRef!, 'failed', intent.amount);
    const hook = signedWebhook(provider, { event: 'failed', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'failed' });
    const out = await processWebhook(store, provider, hook.raw, hook.headers, NOW);
    assert.equal(out.status, 'applied');
    assert.equal(store.getIntent(intent.id)?.status, 'failed');
    const capture = await captureAfterFulfilment(store, FUL, provider, intent.id, 'verified', intent.amount.amountMinor, 'NGN', NOW);
    assert.equal(capture.status, 'blocked');
  });
});

describe('webhook safety', () => {
  test('duplicate webhooks change state once and log once', async () => {
    const { store, provider, intent } = await started();
    provider.setState(intent.providerRef!, 'authorised', intent.amount);
    const hook = signedWebhook(provider, { event: 'authorised', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'authorised' });
    const first = await processWebhook(store, provider, hook.raw, hook.headers, NOW);
    const second = await processWebhook(store, provider, hook.raw, hook.headers, NOW);
    assert.equal(first.status, 'applied');
    assert.equal(second.status, 'duplicate');
    assert.equal(store.audit().filter((e) => e.event === 'provider_authorised').length, 1);
  });

  test('a failed status lookup does not swallow the webhook: the provider retry is applied', async () => {
    const { store, provider, intent } = await started();
    provider.setState(intent.providerRef!, 'authorised', intent.amount);
    const hook = signedWebhook(provider, { event: 'authorised', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'authorised' });
    const flaky = Object.assign(Object.create(provider), {
      getStatus: async () => { throw new Error('network down'); },
    });
    await assert.rejects(processWebhook(store, flaky, hook.raw, hook.headers, NOW));
    assert.equal(store.getIntent(intent.id)?.status, 'initiated');
    const retried = await processWebhook(store, provider, hook.raw, hook.headers, NOW);
    assert.equal(retried.status, 'applied');
    assert.equal(store.getIntent(intent.id)?.status, 'authorised');
  });

  test('a forged or altered body is rejected and recorded', async () => {
    const { store, provider, intent } = await started();
    const hook = signedWebhook(provider, { event: 'authorised', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'authorised' });
    const tampered = hook.raw.replace(String(intent.amount.amountMinor), '1');
    const out = await processWebhook(store, provider, tampered, hook.headers, NOW);
    assert.deepEqual(out, { status: 'rejected', reason: 'bad_signature' });
    assert.equal(store.getIntent(intent.id)?.status, 'initiated');
    assert.ok(store.audit().some((e) => e.event === 'webhook_rejected'));
  });

  test('an unknown reference and a malformed body are rejected, never applied', async () => {
    const { store, provider } = await started();
    const unknown = signedWebhook(provider, { event: 'x', providerRef: 'nope', amount: 1, currency: 'NGN', state: 'authorised' });
    assert.deepEqual(await processWebhook(store, provider, unknown.raw, unknown.headers, NOW), { status: 'rejected', reason: 'unknown_reference' });
    const bad = '{"event":"x"}';
    assert.deepEqual(await processWebhook(store, provider, bad, { [FIXTURE_WEBHOOK_HEADER]: provider.sign(bad) }, NOW), { status: 'rejected', reason: 'malformed' });
  });

  test('the provider is asked for the true status, not the webhook body alone', async () => {
    const { store, provider, intent } = await started();
    // Webhook claims authorised, but the provider says it failed. Provider truth wins.
    provider.setState(intent.providerRef!, 'failed', intent.amount);
    const hook = signedWebhook(provider, { event: 'authorised', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'authorised' });
    const out = await processWebhook(store, provider, hook.raw, hook.headers, NOW);
    assert.deepEqual(out, { status: "applied", intentId: intent.id, to: "failed" });
    assert.equal(store.getIntent(intent.id)?.status, "failed");
  });
});

describe('expired sessions', () => {
  test('a payment after the window is expired is not silently accepted', async () => {
    const { store, provider, intent } = await started();
    const late = '2026-11-12T10:45:00Z';
    assert.deepEqual(expireStaleIntents(store, late), [intent.id]);
    assert.equal(store.getIntent(intent.id)?.status, 'expired');

    provider.setState(intent.providerRef!, 'captured', intent.amount);
    const hook = signedWebhook(provider, { event: 'charge', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'captured' });
    const out = await processWebhook(store, provider, hook.raw, hook.headers, late);
    assert.deepEqual(out, { status: 'review_required', intentId: intent.id, reason: 'late_success' });
  });

  test('an authorisation that outlives its window goes to review, not to capture', async () => {
    const { store, provider, intent } = await started();
    provider.setState(intent.providerRef!, 'authorised', intent.amount);
    await processWebhook(store, provider, ...(() => { const h = signedWebhook(provider, { event: 'a', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'authorised' }); return [h.raw, h.headers, NOW] as const; })());
    expireStaleIntents(store, '2026-11-12T11:00:00Z');
    assert.equal(store.getIntent(intent.id)?.status, 'review_required');
  });
});

describe('amount mismatches', () => {
  test('a provider amount that differs from the intent goes to review', async () => {
    const { store, provider, intent } = await started();
    provider.setState(intent.providerRef!, 'authorised', { amountMinor: intent.amount.amountMinor + 100, currency: 'NGN' });
    const hook = signedWebhook(provider, { event: 'authorised', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'authorised' });
    const out = await processWebhook(store, provider, hook.raw, hook.headers, NOW);
    assert.deepEqual(out, { status: 'review_required', intentId: intent.id, reason: 'amount_mismatch' });
  });

  test('capture refuses when the booking total differs from the intent', async () => {
    const { store, provider, intent } = await started();
    provider.setState(intent.providerRef!, 'authorised', intent.amount);
    const out = await captureAfterFulfilment(store, FUL, provider, intent.id, 'verified', intent.amount.amountMinor + 1, 'NGN', NOW);
    assert.equal(out.status, 'blocked');
    assert.match(out.status === 'blocked' ? out.reasons.join(' ') : '', /does not match/);
  });
});

describe('money safety: capture only after confirmed fulfilment (Option A)', () => {
  async function authorised() {
    const ctx = await started();
    ctx.provider.setState(ctx.intent.providerRef!, 'authorised', ctx.intent.amount);
    const hook = signedWebhook(ctx.provider, { event: 'a', providerRef: ctx.intent.providerRef, amount: ctx.intent.amount.amountMinor, currency: 'NGN', state: 'authorised' });
    await processWebhook(ctx.store, ctx.provider, hook.raw, hook.headers, NOW);
    return ctx;
  }

  for (const fulfilment of ['pending', 'failed', 'unknown'] as const) {
    test(`does not capture while supplier fulfilment is ${fulfilment}`, async () => {
      const { store, provider, intent } = await authorised();
      const out = await captureAfterFulfilment(store, FUL, provider, intent.id, fulfilment, intent.amount.amountMinor, 'NGN', NOW);
      assert.equal(out.status, 'blocked');
      assert.equal(store.getIntent(intent.id)?.status, 'authorised');
    });
  }

  test('supplier booking failure releases the authorisation instead of capturing', async () => {
    const { store, provider, intent } = await authorised();
    const blocked = await captureAfterFulfilment(store, FUL, provider, intent.id, 'failed', intent.amount.amountMinor, 'NGN', NOW);
    assert.equal(blocked.status, 'blocked');
    const released = await releaseAfterSupplierFailure(store, FUL, provider, intent.id, NOW);
    assert.equal(released.status, 'released');
    assert.equal(store.getIntent(intent.id)?.status, 'released');
    assert.equal(store.getIntent(intent.id)?.capturedMinor, 0);
  });

  test('a provider that cannot release sends the intent to review, never to captured', async () => {
    const { store, provider, intent } = await authorised();
    const noRelease = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider, { release: undefined });
    const out = await releaseAfterSupplierFailure(store, FUL, noRelease, intent.id, NOW);
    assert.equal(out.status, 'review_required');
  });
});

describe('refunds', () => {
  test('refuses to refund more than was captured, or a payment never captured', async () => {
    const { store, provider, intent } = await started();
    provider.setState(intent.providerRef!, 'authorised', intent.amount);
    assert.equal((await refund(store, FUL, provider, intent.id, 1, NOW)).status, 'blocked');
  });

  test('refuses a refund larger than the remaining refundable amount', async () => {
    const { store, provider, intent } = await started();
    provider.setState(intent.providerRef!, 'authorised', intent.amount);
    await processWebhook(store, provider, ...(() => { const h = signedWebhook(provider, { event: 'a', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'authorised' }); return [h.raw, h.headers, NOW] as const; })());
    await captureAfterFulfilment(store, FUL, provider, intent.id, 'verified', intent.amount.amountMinor, 'NGN', NOW);
    const out = await refund(store, FUL, provider, intent.id, intent.amount.amountMinor + 1, NOW);
    assert.equal(out.status, 'blocked');
  });

  test('a refund whose outcome is unclear goes to review', async () => {
    const { store, provider, intent } = await started();
    provider.setState(intent.providerRef!, 'authorised', intent.amount);
    await processWebhook(store, provider, ...(() => { const h = signedWebhook(provider, { event: 'a', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'authorised' }); return [h.raw, h.headers, NOW] as const; })());
    await captureAfterFulfilment(store, FUL, provider, intent.id, 'verified', intent.amount.amountMinor, 'NGN', NOW);
    const broken = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider, { refund: async () => { throw new Error('network'); } });
    const out = await refund(store, FUL, broken, intent.id, 100, NOW);
    assert.equal(out.status, 'review_required');
  });
});

describe('booking link: start payment only for a valid booking', () => {
  test('a second attempt for the same booking returns the existing intent and charges nothing new', async () => {
    const { store, provider, booking, intent } = await started();
    const again = await startPayment(store, PAY, provider, new MockFlightSupplier(), booking, { productionEnabled: false }, NOW);
    assert.deepEqual(again, { status: 'duplicate_attempt', intentId: intent.id });
    assert.equal(store.allIntents().length, 1);
  });

  test('production stays off without the owner gate', async () => {
    const store = new PaymentStore();
    const prod = new FixturePaymentProvider(SECRET);
    Object.defineProperty(prod, 'mode', { value: 'production' });
    const out = await startPayment(store, PAY, prod, new MockFlightSupplier(), await bookingFor(), { productionEnabled: false }, NOW);
    assert.equal(out.status === 'blocked' && out.reason, 'production_disabled');
  });

  test('a missing or expired hold blocks payment', async () => {
    const store = new PaymentStore();
    const provider = new FixturePaymentProvider(SECRET);
    const none = await startPayment(store, PAY, provider, new MockFlightSupplier(), await bookingFor({ holdId: '' }), { productionEnabled: false }, NOW);
    assert.equal(none.status === 'blocked' && none.reason, 'hold_missing');
    const expired = await startPayment(store, PAY, provider, new MockFlightSupplier(), await bookingFor(), { productionEnabled: false }, '2026-11-12T11:00:00Z');
    assert.equal(expired.status === 'blocked' && expired.reason, 'hold_expired');
  });

  test('an expired fare is revalidated and blocks payment', async () => {
    const out = await startPayment(new PaymentStore(), PAY, new FixturePaymentProvider(SECRET), new MockFlightSupplier(),
      await bookingFor({ holdExpiresAtUtc: '2027-01-02T00:00:00Z' }), { productionEnabled: false }, '2027-01-01T00:00:00Z');
    assert.equal(out.status === 'blocked' && out.reason, 'fare_expired');
  });

  test('a fare that changed blocks payment until the customer accepts', async () => {
    const offer = await fixtureOffer();
    const supplier = { ...new MockFlightSupplier(), name: 'mock', mode: 'mock' as const, capabilities: { holds: true }, search: async () => [], priceOffer: async (o: Offer) => ({ ...o, supplierPrice: { amountMinor: o.supplierPrice.amountMinor + 500, currency: 'USD' as const } }) };
    const out = await startPayment(new PaymentStore(), PAY, new FixturePaymentProvider(SECRET), supplier as unknown as FlightSupplier,
      await bookingFor({ offer }), { productionEnabled: false }, NOW);
    assert.equal(out.status === 'blocked' && out.reason, 'fare_changed');
  });

  test('an amount that differs from the accepted summary is refused', async () => {
    const out = await startPayment(new PaymentStore(), PAY, new FixturePaymentProvider(SECRET), new MockFlightSupplier(),
      await bookingFor({ totalMinor: 1 }), { productionEnabled: false }, NOW);
    assert.equal(out.status === 'blocked' && out.reason, 'amount_mismatch');
  });

  test("a supplier that cannot revalidate fares blocks payment", async () => {
    const noRevalidate = { ...new MockFlightSupplier(), priceOffer: undefined };
    const out = await startPayment(new PaymentStore(), PAY, new FixturePaymentProvider(SECRET), noRevalidate as unknown as FlightSupplier,
      await bookingFor(), { productionEnabled: false }, NOW);
    assert.equal(out.status === "blocked" && out.reason, "supplier_unavailable");
  });

  test('a supplier that is down blocks payment with its reason', async () => {
    const down = { ...new MockFlightSupplier(), priceOffer: async () => { throw new SupplierUnavailableError('timeout', 'slow'); } };
    const out = await startPayment(new PaymentStore(), PAY, new FixturePaymentProvider(SECRET), down as unknown as FlightSupplier,
      await bookingFor(), { productionEnabled: false }, NOW);
    assert.equal(out.status === 'blocked' && out.reason, 'supplier_unavailable');
  });
});

describe('real providers are outside the booking payment flow', () => {
  test('the booking payment allow-list holds only the fixture provider', () => {
    assert.deepEqual([...BOOKING_PAYMENT_PROVIDERS], ['fixture']);
  });

  test('Paystack is excluded by name: it captures on payment, before ticket verification', async () => {
    const out = await startPayment(new PaymentStore(), PAY, new PaystackPaymentProvider({ mode: 'sandbox', secretKey: 'sk_test_x' }),
      new MockFlightSupplier(), await bookingFor(), { productionEnabled: false }, NOW);
    assert.equal(out.status === 'blocked' && out.reason, 'provider_excluded');
  });

  test('Flutterwave is excluded by name until its capture is confirmed', async () => {
    const out = await startPayment(new PaymentStore(), PAY, new FlutterwavePaymentProvider({ mode: 'sandbox', secretHash: 'h' }),
      new MockFlightSupplier(), await bookingFor(), { productionEnabled: false }, NOW);
    assert.equal(out.status === 'blocked' && out.reason, 'provider_excluded');
  });
});

describe('Paystack webhook verification', () => {
  const body = JSON.stringify({ event: 'charge.success', data: { id: 4001, reference: 'r1', amount: 15000000, currency: 'NGN', status: 'success' } });
  const sign = (secret: string, raw: string) => createHmac('sha512', secret).update(raw).digest('hex');

  test('accepts a correct HMAC-SHA512 signature over the raw body', () => {
    const p = new PaystackPaymentProvider({ mode: 'sandbox', secretKey: 'sk_test_x' });
    assert.equal(p.verifyWebhook(body, { [PAYSTACK_SIGNATURE_HEADER]: sign('sk_test_x', body) }).valid, true);
  });

  test('rejects a wrong key, a missing header, and a re-serialised body', () => {
    const p = new PaystackPaymentProvider({ mode: 'sandbox', secretKey: 'sk_test_x' });
    assert.equal(p.verifyWebhook(body, { [PAYSTACK_SIGNATURE_HEADER]: sign('wrong', body) }).valid, false);
    assert.equal(p.verifyWebhook(body, {}).valid, false);
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    assert.equal(p.verifyWebhook(reserialised, { [PAYSTACK_SIGNATURE_HEADER]: sign('sk_test_x', body) }).valid, false);
  });

  test('refuses every webhook when the secret is not configured', () => {
    const p = new PaystackPaymentProvider({ mode: 'sandbox' });
    assert.equal(p.verifyWebhook(body, { [PAYSTACK_SIGNATURE_HEADER]: sign('sk_test_x', body) }).valid, false);
  });

  test('maps a successful charge to captured and a failure to failed', () => {
    const p = new PaystackPaymentProvider({ mode: 'sandbox', secretKey: 'k' });
    assert.equal(p.parseWebhook(body).reportedState, 'captured');
    assert.equal(p.parseWebhook(JSON.stringify({ event: 'charge.failed', data: { id: 4002, reference: 'r', amount: 1, currency: 'NGN' } })).reportedState, 'failed');
  });

  test('will not call the network for authorisation or for production without approval', async () => {
    const p = new PaystackPaymentProvider({ mode: 'production', secretKey: 'k' });
    await assert.rejects(p.getStatus('r'), (e: unknown) => (e as { reason?: string }).reason === 'not_supported');
    await assert.rejects(p.initiate({ reference: 'r', amount: { amountMinor: 1, currency: 'NGN' }, customerEmail: 'a@b.co', expiresAtUtc: NOW, mode: 'authorise' }),
      (e: unknown) => (e as { reason?: string }).reason === 'not_supported');
  });
});

describe('Flutterwave webhook verification', () => {
  test('compares the verif-hash header with the configured secret hash', () => {
    const p = new FlutterwavePaymentProvider({ mode: 'sandbox', secretHash: 'hash-123' });
    assert.equal(p.verifyWebhook('{}', { [FLUTTERWAVE_HASH_HEADER]: 'hash-123' }).valid, true);
    assert.equal(p.verifyWebhook('{}', { [FLUTTERWAVE_HASH_HEADER]: 'hash-124' }).valid, false);
    assert.equal(p.verifyWebhook('{}', {}).valid, false);
  });

  test('refuses everything when no secret hash is set', () => {
    const p = new FlutterwavePaymentProvider({ mode: 'sandbox' });
    assert.equal(p.verifyWebhook('{}', { [FLUTTERWAVE_HASH_HEADER]: '' }).valid, false);
  });
});

describe('reconciliation', () => {
  test('reports state and amount mismatches and changes nothing', async () => {
    const { store, provider, intent } = await started();
    provider.setState(intent.providerRef!, 'failed', intent.amount); // we think initiated, provider says failed
    const before = JSON.stringify(store.allIntents());
    const gaps = await reconcile(store, [provider]);
    assert.equal(gaps.length, 0, 'initiated has no expected provider state, so no gap yet');

    const other = await started();
    other.provider.setState(other.intent.providerRef!, 'authorised', { amountMinor: other.intent.amount.amountMinor + 1, currency: 'NGN' });
    other.store.saveIntent({ ...other.intent, status: 'authorised' });
    const found = await reconcile(other.store, [other.provider]);
    assert.equal(found[0]?.kind, 'amount_mismatch');
    assert.equal(JSON.stringify(store.allIntents()), before);
  });
});

describe('audit log', () => {
  test('records every transition and cannot be edited through the store', async () => {
    const { store, provider, intent } = await started();
    provider.setState(intent.providerRef!, 'failed', intent.amount);
    const hook = signedWebhook(provider, { event: 'failed', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'failed' });
    await processWebhook(store, provider, hook.raw, hook.headers, NOW);
    const log = store.audit();
    assert.deepEqual(log.map((e) => e.event), ['initiated', 'action_authorised', 'provider_failed']);
    (log as unknown as { push: (e: unknown) => void }).push({ bogus: true });
    assert.equal(store.audit().length, 3);
  });
});

describe('Paystack redirect address (customer is sent here)', () => {
  test('accepts an HTTPS address on a Paystack domain', () => {
    assert.equal(requirePaystackRedirect('https://checkout.paystack.com/abc123'), 'https://checkout.paystack.com/abc123');
  });

  test('refuses plain HTTP, other hosts, lookalike hosts and embedded credentials', () => {
    assert.throws(() => requirePaystackRedirect('http://checkout.paystack.com/abc'), /not an allowed/);
    assert.throws(() => requirePaystackRedirect('https://evil.example.com/abc'), /not an allowed/);
    assert.throws(() => requirePaystackRedirect('https://paystack.com.evil.example.com/abc'), /not an allowed/);
    assert.throws(() => requirePaystackRedirect('https://user:pass@checkout.paystack.com/abc'), /not an allowed/);
    assert.throws(() => requirePaystackRedirect('javascript:alert(1)'), /not an allowed|not a valid URL/);
  });
});

describe('concurrent payment starts (regression)', () => {
  test('two concurrent starts for one booking create one provider session, never two', async () => {
    const supplier = new MockFlightSupplier();
    const [offer] = await supplier.search({ origin: 'LOS', destination: 'LHR', departureDate: '2026-12-01', passengers: 1, cabin: 'economy', displayCurrency: 'NGN' });
    const store = new PaymentStore();
    const provider = new FixturePaymentProvider('secret');
    let initiations = 0;
    const counted = Object.assign(Object.create(provider), {
      initiate: async (req: InitiateRequest) => { initiations += 1; return provider.initiate(req); },
    });
    const booking = { bookingId: 'b-race', holdId: 'h', holdExpiresAtUtc: '2026-11-19T12:00:00Z', offer, totalMinor: offer.displayPrice.amountMinor, currency: 'NGN' as const, customerEmail: 'a@example.com' };
    const [a, b] = await Promise.all([
      startPayment(store, PAY, counted, supplier, booking, { productionEnabled: false }, NOW),
      startPayment(store, PAY, counted, supplier, booking, { productionEnabled: false }, NOW),
    ]);
    assert.equal(initiations, 1);
    assert.deepEqual([a.status, b.status].sort(), ['blocked', 'initiated']);
    assert.equal(store.allIntents().length, 1);
  });
});

describe('money paths enforce actors (regression)', () => {
  test('a customer can start a payment only on their own booking; another customer is refused and nothing is created', async () => {
    const supplier = new MockFlightSupplier();
    const [offer] = await supplier.search({ origin: 'LOS', destination: 'LHR', departureDate: '2026-12-01', passengers: 1, cabin: 'economy', displayCurrency: 'NGN' });
    const provider = new FixturePaymentProvider('secret');
    const store = new PaymentStore();
    const booking = { bookingId: 'b-own', ownerUserId: 'cust-alice', holdId: 'h', holdExpiresAtUtc: '2026-11-19T12:00:00Z', offer, totalMinor: offer.displayPrice.amountMinor, currency: 'NGN' as const, customerEmail: 'a@example.com' };
    const alice: Actor = { kind: 'user', userId: 'cust-alice', role: 'customer', mfa: false };
    const bob: Actor = { kind: 'user', userId: 'cust-bob', role: 'customer', mfa: false };
    await assert.rejects(startPayment(store, bob, provider, supplier, booking, { productionEnabled: false }, NOW), /only the booking owner/);
    assert.equal(store.allIntents().length, 0);
    const out = await startPayment(store, alice, provider, supplier, booking, { productionEnabled: false }, NOW);
    assert.equal(out.status, 'initiated');
  });

  test('a support agent cannot refund a captured payment, even with MFA', async () => {
    const { store, provider, intent } = await started();
    provider.setState(intent.providerRef!, 'authorised', intent.amount);
    const hook = signedWebhook(provider, { event: 'authorised', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'authorised' });
    await processWebhook(store, provider, hook.raw, hook.headers, NOW);
    const support: Actor = { kind: 'user', userId: 'staff-1', role: 'support', mfa: true };
    await assert.rejects(refund(store, support, provider, intent.id, 1, NOW), /not permitted/);
    assert.equal(store.getIntent(intent.id)?.refundedMinor, 0);
  });
});

describe('payment attempts are distinct (regression)', () => {
  test('a retry after a failed attempt gets a new reference, so the provider does not reuse the old session key', async () => {
    const supplier = new MockFlightSupplier();
    const [offer] = await supplier.search({ origin: 'LOS', destination: 'LHR', departureDate: '2026-12-01', passengers: 1, cabin: 'economy', displayCurrency: 'NGN' });
    const provider = new FixturePaymentProvider('secret');
    const store = new PaymentStore();
    const booking = { bookingId: 'b-retry', holdId: 'h', holdExpiresAtUtc: '2026-11-19T12:00:00Z', offer, totalMinor: offer.displayPrice.amountMinor, currency: 'NGN' as const, customerEmail: 'a@example.com' };
    const first = await startPayment(store, PAY, provider, supplier, booking, { productionEnabled: false }, NOW);
    assert.equal(first.status, 'initiated');
    const firstIntent = store.getIntent((first as { intentId: string }).intentId)!;
    store.saveIntent({ ...firstIntent, status: 'failed' });
    const second = await startPayment(store, PAY, provider, supplier, booking, { productionEnabled: false }, NOW);
    assert.equal(second.status, 'initiated');
    const secondIntent = store.getIntent((second as { intentId: string }).intentId)!;
    assert.notEqual(secondIntent.reference, firstIntent.reference);
    assert.notEqual(secondIntent.id, firstIntent.id);
  });
});

describe('provider events and capture controls (docs/25, section 9)', () => {
  test('a provider capture for an intent with no capture request goes to review, never to captured', async () => {
    const { store, provider, intent } = await started();
    // The provider's own status is the authority. The customer has authorised the payment at the provider.
    provider.setState(intent.providerRef as string, 'authorised', intent.amount);
    const auth = signedWebhook(provider, { event: 'authorised', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'authorised' });
    assert.equal((await processWebhook(store, provider, auth.raw, auth.headers, NOW)).status, 'applied');
    provider.setState(intent.providerRef as string, 'captured', intent.amount); // the provider says captured, with no request from GO
    const cap = signedWebhook(provider, { event: 'charge', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'captured' });
    const out = await processWebhook(store, provider, cap.raw, cap.headers, NOW);
    assert.equal(out.status, 'review_required');
    assert.notEqual(store.getIntent(intent.id)?.status, 'captured');
  });

  test('capture is requested first and confirmed only from the provider status, and both steps are audited', async () => {
    const { store, provider, intent } = await started();
    // The provider's own status is the authority. The customer has authorised the payment at the provider.
    provider.setState(intent.providerRef as string, 'authorised', intent.amount);
    const auth = signedWebhook(provider, { event: 'authorised', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'authorised' });
    await processWebhook(store, provider, auth.raw, auth.headers, NOW);
    const out = await captureAfterFulfilment(store, FUL, provider, intent.id, 'verified', intent.amount.amountMinor, 'NGN', NOW);
    assert.equal(out.status, 'captured');
    assert.equal(store.getIntent(intent.id)?.capturedMinor, intent.amount.amountMinor);
    const events = store.audit().map((e) => e.event);
    const requested = events.indexOf('capture_requested');
    const confirmed = events.indexOf('capture_confirmed');
    assert.ok(requested >= 0 && confirmed > requested, events.join(','));
  });

  test('a capture the provider reports as not taken returns the hold to authorised, not to captured', async () => {
    const { store, provider, intent } = await started();
    // The provider's own status is the authority. The customer has authorised the payment at the provider.
    provider.setState(intent.providerRef as string, 'authorised', intent.amount);
    const auth = signedWebhook(provider, { event: 'authorised', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'authorised' });
    await processWebhook(store, provider, auth.raw, auth.headers, NOW);
    // The capture call succeeds at the transport level, but the provider's status still says authorised.
    const declined = Object.assign(Object.create(provider), { capture: async () => undefined });
    const out = await captureAfterFulfilment(store, FUL, declined, intent.id, 'verified', intent.amount.amountMinor, 'NGN', NOW);
    assert.equal(out.status, 'review_required');
    assert.equal(store.getIntent(intent.id)?.status, 'authorised');
  });

  test('a provider amount that differs when the capture is confirmed goes to review, never to captured', async () => {
    const { store, provider, intent } = await started();
    // The provider's own status is the authority. The customer has authorised the payment at the provider.
    provider.setState(intent.providerRef as string, 'authorised', intent.amount);
    const auth = signedWebhook(provider, { event: 'authorised', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'authorised' });
    await processWebhook(store, provider, auth.raw, auth.headers, NOW);
    const wrongAmount = Object.assign(Object.create(provider), { capture: async () => undefined });
    provider.setState(intent.providerRef as string, 'captured', { amountMinor: intent.amount.amountMinor + 1, currency: 'NGN' } as never);
    const out = await captureAfterFulfilment(store, FUL, wrongAmount, intent.id, 'verified', intent.amount.amountMinor, 'NGN', NOW);
    assert.equal(out.status, 'review_required');
    assert.notEqual(store.getIntent(intent.id)?.status, 'captured');
  });

  test('every webhook attempt is recorded with the provider event id, event name, time and result', async () => {
    const { store, provider, intent } = await started();
    // The provider's own status is the authority. The customer has authorised the payment at the provider.
    provider.setState(intent.providerRef as string, 'authorised', intent.amount);
    const hook = signedWebhook(provider, { event: 'authorised', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'authorised' });
    const eventId = (JSON.parse(hook.raw) as { id: string }).id;
    await processWebhook(store, provider, hook.raw, hook.headers, NOW);
    const entry = store.audit().find((e) => e.detail.includes(`event ${eventId}`));
    assert.ok(entry, 'the provider event id is recorded');
    assert.ok(entry.detail.includes('authorised'), 'the event name is recorded');
    assert.equal(entry.at, NOW);
  });

  test('a replayed event with the same id is a duplicate, even when its body differs', async () => {
    const { store, provider, intent } = await started();
    // The provider's own status is the authority. The customer has authorised the payment at the provider.
    provider.setState(intent.providerRef as string, 'authorised', intent.amount);
    const first = { id: 'evt-replay-1', event: 'authorised', providerRef: intent.providerRef, amount: intent.amount.amountMinor, currency: 'NGN', state: 'authorised' };
    const raw1 = JSON.stringify(first);
    assert.equal((await processWebhook(store, provider, raw1, { [FIXTURE_WEBHOOK_HEADER]: provider.sign(raw1) }, NOW)).status, 'applied');
    const raw2 = JSON.stringify({ ...first, state: 'failed', event: 'failed' });
    const out = await processWebhook(store, provider, raw2, { [FIXTURE_WEBHOOK_HEADER]: provider.sign(raw2) }, NOW);
    assert.equal(out.status, 'duplicate');
    assert.equal(store.getIntent(intent.id)?.status, 'authorised');
  });
});
