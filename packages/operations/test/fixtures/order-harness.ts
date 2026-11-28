// Builds the state an order or capture needs, from fixtures only. Used by the process worker and the integration
// tests. Every value is deterministic for a given booking id, so a fresh process rebuilds the same keys. Booking,
// payment and supplier state is in memory here, as it is in the application today. Only the operation ledger is
// durable, and the restart tests check exactly that.

import { FixtureOrderSupplier, type OrderKnobs } from '../../../fulfilment/src/fixture-orders.ts';
import { FulfilmentStore, type FulfilmentRecord } from '../../../fulfilment/src/store.ts';
import type { FulfilmentDeps } from '../../../fulfilment/src/orchestrator.ts';
import type { HoldPassenger, Offer } from '../../../flights/src/supplier.ts';
import { FixturePaymentProvider, FIXTURE_WEBHOOK_HEADER } from '../../../payments/src/adapters/fixture.ts';
import { PaymentStore } from '../../../payments/src/store.ts';
import { startPayment } from '../../../payments/src/payment-flow.ts';
import { processWebhook } from '../../../payments/src/webhook.ts';
import type { OperationLedger } from '../../src/ledger.ts';
import type { Actor } from '../../../auth/src/actor.ts';

export const NOW = '2026-11-12T09:30:00Z';
export const HOLD_EXPIRY = '2026-11-12T10:00:00Z';
export const FUL: Actor = { kind: 'system', service: 'fulfilment' };
const PAY: Actor = { kind: 'system', service: 'payments' };
const SECRET = 'fixture-secret';

export interface HarnessOptions {
  readonly bookingId: string;
  readonly ledger: OperationLedger;
  readonly knobs?: OrderKnobs;
  readonly externalLeaseSeconds?: number;
  readonly status?: 'authorised' | 'verified';
}

export interface Harness {
  readonly deps: FulfilmentDeps;
  readonly supplier: FixtureOrderSupplier;
  readonly payments: FixturePaymentProvider;
  readonly payStore: PaymentStore;
  readonly store: FulfilmentStore;
  readonly offer: Offer;
  readonly intentId: string;
}

export async function buildHarness(options: HarnessOptions): Promise<Harness> {
  const supplier = new FixtureOrderSupplier(options.knobs ?? {});
  const [offer] = await supplier.search({
    origin: 'LOS', destination: 'LHR', departureDate: '2026-12-01', passengers: 1, cabin: 'economy', displayCurrency: 'NGN',
  });
  const payments = new FixturePaymentProvider(SECRET);
  const payStore = new PaymentStore();
  const started = await startPayment(payStore, PAY, payments, supplier, {
    bookingId: options.bookingId, holdId: 'hold_1', holdExpiresAtUtc: HOLD_EXPIRY, offer, totalMinor: offer.displayPrice.amountMinor,
    currency: 'NGN', customerEmail: 'ada@example.com',
  }, { productionEnabled: false }, NOW);
  if (started.status !== 'initiated') throw new Error(`payment did not start: ${started.status}`);
  const intent = payStore.getIntent(started.intentId)!;
  payments.setState(intent.providerRef!, 'authorised', intent.amount);
  const raw = JSON.stringify({
    id: `evt-${options.bookingId}-auth`, event: 'authorised', providerRef: intent.providerRef,
    amount: intent.amount.amountMinor, currency: 'NGN', state: 'authorised',
  });
  await processWebhook(payStore, payments, raw, { [FIXTURE_WEBHOOK_HEADER]: payments.sign(raw) }, NOW);

  const store = new FulfilmentStore();
  const passengers: HoldPassenger[] = [{ type: 'adult', firstName: 'Ada', lastName: 'Okafor', dateOfBirth: '1990-05-14', nationality: 'NG' }];
  // A restored booking starts in the status it had when its state was last saved. The payment intent is still authorised.
  const record: FulfilmentRecord = {
    bookingId: options.bookingId, status: options.status ?? 'authorised', intentId: intent.id, offer, passengers,
    totalMinor: offer.displayPrice.amountMinor, currency: 'NGN', holdExpiresAtUtc: HOLD_EXPIRY, orderId: null,
    bookingReference: null, documents: [], lockedReason: null, blockedReason: null,
  };
  store.create(record);
  const deps: FulfilmentDeps = {
    supplier, payments, payStore, store, ledger: options.ledger, externalLeaseSeconds: options.externalLeaseSeconds,
  };
  return { deps, supplier, payments, payStore, store, offer, intentId: intent.id };
}
