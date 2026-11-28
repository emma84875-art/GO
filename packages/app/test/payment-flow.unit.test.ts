// Unit checks for the payment flow on the database authority. The ledger is the in-memory fixture, and the authority is
// a double with the same idempotency and binding rules. The database itself is checked by supabase/tests/payment_authority.sql
// and by app.integration.test.ts. Each test here fixes one branch of the write-ahead start, reconciliation or webhook path.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryOperationLedger } from '../../operations/src/ledger.ts';
import type { PaymentAuthority, PaymentRow, ProviderEventInput, ProviderEventResult, StartInput } from '../../payments/src/authority.ts';
import { handleWebhookDurable, paymentStartReference, reconcilePaymentStart, startPaymentDurable, type StartRequest } from '../../payments/src/durable-flow.ts';
import type { PaymentProvider, InitiateRequest, ProviderStatus } from '../../payments/src/provider.ts';
import { FixturePaymentProvider } from '../../payments/src/adapters/fixture.ts';
import type { Actor } from '../../auth/src/actor.ts';

const NOW = '2026-11-12T09:30:00Z';
const BOOKING = '00000000-0000-0000-0000-0000000000c1';
const OWNER = '00000000-0000-0000-0000-0000000000d1';
const PAY: Actor = { kind: 'system', service: 'payments' };
const REQUEST: StartRequest = {
  bookingId: BOOKING, ownerUserId: OWNER, amountMinor: 150000, currency: 'NGN', customerEmail: 'ada@example.com',
  holdExpiresAtUtc: '2026-11-12T10:00:00Z',
};

// A test double of the database authority. It applies the same idempotency and binding rules as the SQL functions.
class FakeAuthority implements PaymentAuthority {
  readonly rows = new Map<string, PaymentRow>();
  readonly events = new Map<string, ProviderEventResult>();
  failStart = false;
  failBind = false;
  order: string[] = [];
  #next = 1;

  async start(input: StartInput): Promise<string> {
    this.order.push('authority.start');
    if (this.failStart) throw new Error('database unavailable');
    const existing = [...this.rows.values()].find((r) => r.reference === input.reference);
    if (existing) return existing.id;
    const id = `pay-${this.#next++}`;
    this.rows.set(id, {
      id, bookingId: input.bookingId, provider: input.provider, providerReference: `pending:${input.reference}`,
      reference: input.reference, amountMinor: input.amountMinor, currency: input.currency, status: 'initiated',
      capturedMinor: 0, refundedMinor: 0, expiresAtUtc: input.expiresAtUtc,
    });
    return id;
  }

  async bindProviderReference(paymentId: string, providerReference: string): Promise<void> {
    this.order.push('authority.bind');
    if (this.failBind) throw new Error('database unavailable');
    const row = this.rows.get(paymentId)!;
    if (row.providerReference === providerReference) return;
    if (!row.providerReference.startsWith('pending:')) throw new Error('already bound');
    this.rows.set(paymentId, { ...row, providerReference });
  }

  async load(paymentId: string) { return this.rows.get(paymentId) ?? null; }

  async findByReference(reference: string) {
    return [...this.rows.values()].find((r) => r.reference === reference) ?? null;
  }

  async applyProviderEvent(input: ProviderEventInput): Promise<ProviderEventResult> {
    const key = `${input.provider}|${input.eventId}`;
    if (input.verification === 'none') return 'rejected';
    if (this.events.has(key)) return 'duplicate';
    this.events.set(key, 'applied');
    return 'applied';
  }
}

// A provider double. It records each initiation, and can be made to fail in a chosen way.
class ScriptedProvider implements PaymentProvider {
  readonly name = 'fixture';
  readonly mode = 'fixture' as const;
  readonly capabilities = new FixturePaymentProvider('s').capabilities;
  readonly initiated: string[] = [];
  reply: 'ok' | 'throw' = 'ok';
  evidence: { providerRef: string; status: ProviderStatus } | null = null;
  readonly #inner = new FixturePaymentProvider('s');
  readonly hasLookup: boolean;

  constructor(hasLookup = true) {
    this.hasLookup = hasLookup;
    if (hasLookup) {
      this.findByReference = async () => this.evidence;
    }
  }

  findByReference?: (reference: string) => Promise<{ providerRef: string; status: ProviderStatus } | null>;

  async initiate(request: InitiateRequest) {
    this.initiated.push(request.reference);
    if (this.reply === 'throw') throw new Error('timed out');
    return { providerRef: `fx_${request.reference.replace(/[^a-z0-9]+/gi, '_')}`, redirectUrl: 'https://fixture.invalid' };
  }
  async getStatus(): Promise<ProviderStatus> { throw new Error('not used'); }
  verifyWebhook(raw: string, headers: Readonly<Record<string, string | undefined>>) { return this.#inner.verifyWebhook(raw, headers); }
  parseWebhook(raw: string) { return this.#inner.parseWebhook(raw); }
}

function deps(authority: FakeAuthority, provider: ScriptedProvider, productionEnabled = false) {
  const ledger = new MemoryOperationLedger(() => NOW);
  return { authority, ledger, provider, gate: { productionEnabled } };
}

describe('write-ahead start', () => {
  test('the payment is recorded before the provider is called', async () => {
    const authority = new FakeAuthority();
    const provider = new ScriptedProvider();
    const originalInitiate = provider.initiate.bind(provider);
    provider.initiate = async (request) => {
      authority.order.push('provider.initiate');
      return originalInitiate(request);
    };
    const outcome = await startPaymentDurable(deps(authority, provider), PAY, REQUEST, NOW);
    assert.equal(outcome.status, 'started');
    assert.deepEqual(authority.order, ['authority.start', 'provider.initiate', 'authority.bind']);
  });

  test('a start records the provider reference and the ledger success', async () => {
    const authority = new FakeAuthority();
    const provider = new ScriptedProvider();
    const outcome = await startPaymentDurable(deps(authority, provider), PAY, REQUEST, NOW);
    assert.equal(outcome.status, 'started');
    if (outcome.status !== 'started') return;
    assert.equal(outcome.reused, false);
    assert.equal(authority.rows.get(outcome.paymentId)?.providerReference, outcome.providerReference);
    assert.deepEqual(provider.initiated, [paymentStartReference(BOOKING)]);
  });

  test('a repeat start reuses the recorded payment and does not initiate again', async () => {
    const authority = new FakeAuthority();
    const provider = new ScriptedProvider();
    const ledger = new MemoryOperationLedger(() => NOW);
    const d = { authority, ledger, provider, gate: { productionEnabled: false } };
    const first = await startPaymentDurable(d, PAY, REQUEST, NOW);
    const second = await startPaymentDurable(d, PAY, REQUEST, NOW);
    assert.equal(second.status, 'started');
    if (second.status === 'started' && first.status === 'started') {
      assert.equal(second.reused, true);
      assert.equal(second.paymentId, first.paymentId);
    }
    assert.equal(provider.initiated.length, 1);
  });

  test('a provider that is not approved for booking payments is refused before anything is written', async () => {
    const authority = new FakeAuthority();
    const provider = new ScriptedProvider();
    (provider as { name: string }).name = 'paystack';
    const outcome = await startPaymentDurable(deps(authority, provider), PAY, REQUEST, NOW);
    assert.equal(outcome.status, 'refused');
    assert.equal(authority.rows.size, 0);
    assert.equal(provider.initiated.length, 0);
  });

  test('a production provider is refused while the owner gate is off', async () => {
    const authority = new FakeAuthority();
    const provider = new ScriptedProvider();
    (provider as { mode: string }).mode = 'production';
    const outcome = await startPaymentDurable(deps(authority, provider, false), PAY, REQUEST, NOW);
    assert.equal(outcome.status, 'refused');
    assert.equal(provider.initiated.length, 0);
  });

  test('a lapsed hold, a zero amount, and a non-whole amount are refused', async () => {
    for (const bad of [
      { ...REQUEST, holdExpiresAtUtc: '2026-11-12T09:00:00Z' },
      { ...REQUEST, amountMinor: 0 },
      { ...REQUEST, amountMinor: 10.5 },
    ]) {
      const authority = new FakeAuthority();
      const provider = new ScriptedProvider();
      const outcome = await startPaymentDurable(deps(authority, provider), PAY, bad, NOW);
      assert.equal(outcome.status, 'refused');
      assert.equal(provider.initiated.length, 0);
    }
  });

  test('a provider error is unknown: reconciliation is required and the provider is not asked again', async () => {
    const authority = new FakeAuthority();
    const provider = new ScriptedProvider();
    const d = deps(authority, provider);
    provider.reply = 'throw';
    const first = await startPaymentDurable(d, PAY, REQUEST, NOW);
    assert.equal(first.status, 'reconciliation_required');
    const second = await startPaymentDurable(d, PAY, REQUEST, NOW);
    assert.equal(second.status, 'reconciliation_required');
    assert.equal(provider.initiated.length, 1, 'the second attempt must not contact the provider');
  });

  test('a failure to record the payment stops before the provider and allows a later retry', async () => {
    const authority = new FakeAuthority();
    const provider = new ScriptedProvider();
    const d = deps(authority, provider);
    authority.failStart = true;
    const blocked = await startPaymentDurable(d, PAY, REQUEST, NOW);
    assert.equal(blocked.status, 'blocked');
    assert.equal(provider.initiated.length, 0, 'nothing reached the provider');
    authority.failStart = false;
    const retried = await startPaymentDurable(d, PAY, REQUEST, NOW);
    assert.equal(retried.status, 'started');
    assert.equal(provider.initiated.length, 1);
  });

  test('a failure to record the provider reference after the provider accepted is unknown, not failed', async () => {
    const authority = new FakeAuthority();
    const provider = new ScriptedProvider();
    const d = deps(authority, provider);
    authority.failBind = true;
    const outcome = await startPaymentDurable(d, PAY, REQUEST, NOW);
    assert.equal(outcome.status, 'reconciliation_required');
    assert.equal(provider.initiated.length, 1);
    const again = await startPaymentDurable(d, PAY, REQUEST, NOW);
    assert.equal(again.status, 'reconciliation_required');
    assert.equal(provider.initiated.length, 1);
  });
});

describe('reconciliation of an unknown start', () => {
  async function unknownStart() {
    const authority = new FakeAuthority();
    const provider = new ScriptedProvider();
    const ledger = new MemoryOperationLedger(() => NOW);
    const d = { authority, ledger, provider, gate: { productionEnabled: false } };
    provider.reply = 'throw';
    await startPaymentDurable(d, PAY, REQUEST, NOW);
    provider.reply = 'ok';
    return { authority, provider, ledger };
  }

  test('reconciliation needs a reconciliation actor', async () => {
    const { authority, provider, ledger } = await unknownStart();
    const out = await reconcilePaymentStart({ authority, ledger, provider }, BOOKING, 'backend:someone');
    assert.equal(out.status, 'unavailable');
  });

  test('a provider that cannot look up references leaves the start unknown', async () => {
    const authority = new FakeAuthority();
    const provider = new ScriptedProvider(false);
    const ledger = new MemoryOperationLedger(() => NOW);
    provider.reply = 'throw';
    await startPaymentDurable({ authority, ledger, provider, gate: { productionEnabled: false } }, PAY, REQUEST, NOW);
    const out = await reconcilePaymentStart({ authority, ledger, provider }, BOOKING, 'reconciliation:ops');
    assert.equal(out.status, 'unavailable');
  });

  test('provider evidence of no payment allows one new attempt', async () => {
    const { authority, provider, ledger } = await unknownStart();
    provider.evidence = null;
    const out = await reconcilePaymentStart({ authority, ledger, provider }, BOOKING, 'reconciliation:ops');
    assert.equal(out.status, 'retry_allowed');
  });

  test('provider evidence of a matching payment records the reference and the success', async () => {
    const { authority, provider, ledger } = await unknownStart();
    const reference = paymentStartReference(BOOKING);
    provider.evidence = {
      providerRef: `fx_${reference.replace(/[^a-z0-9]+/gi, '_')}`,
      status: { state: 'pending', amount: { amountMinor: 150000, currency: 'NGN' } as never },
    };
    const out = await reconcilePaymentStart({ authority, ledger, provider }, BOOKING, 'reconciliation:ops');
    assert.equal(out.status, 'started');
    if (out.status === 'started') {
      assert.equal(authority.rows.get(out.paymentId)?.providerReference, out.providerReference);
    }
    const again = await reconcilePaymentStart({ authority, ledger, provider }, BOOKING, 'reconciliation:ops');
    assert.equal(again.status, 'not_needed');
  });

  test('provider evidence with a different amount goes to review and changes nothing', async () => {
    const { authority, provider, ledger } = await unknownStart();
    const reference = paymentStartReference(BOOKING);
    provider.evidence = {
      providerRef: `fx_${reference.replace(/[^a-z0-9]+/gi, '_')}`,
      status: { state: 'pending', amount: { amountMinor: 1, currency: 'NGN' } as never },
    };
    const out = await reconcilePaymentStart({ authority, ledger, provider }, BOOKING, 'reconciliation:ops');
    assert.equal(out.status, 'review_required');
    const row = await authority.findByReference(reference);
    assert.match(row!.providerReference, /^pending:/, 'the reference is not bound on a mismatch');
  });
});

describe('webhook on the database authority', () => {
  test('a bad signature is rejected and recorded as rejected', async () => {
    const authority = new FakeAuthority();
    const provider = new ScriptedProvider();
    const raw = JSON.stringify({ id: 'evt-1', event: 'authorised', providerRef: 'fx_x', amount: 1, currency: 'NGN', state: 'authorised' });
    const out = await handleWebhookDurable({ authority, provider }, raw, { 'x-fixture-signature': 'wrong' }, NOW);
    assert.deepEqual(out, { status: 'rejected', reason: 'bad_signature' });
  });

  test('a malformed body is rejected', async () => {
    const authority = new FakeAuthority();
    const provider = new ScriptedProvider();
    const raw = '{"not":"a webhook"}';
    const sig = new FixturePaymentProvider('s').sign(raw);
    const out = await handleWebhookDurable({ authority, provider }, raw, { 'x-fixture-signature': sig }, NOW);
    assert.deepEqual(out, { status: 'rejected', reason: 'malformed' });
  });

  test('a signed event is applied once; the repeat is a duplicate', async () => {
    const authority = new FakeAuthority();
    const provider = new ScriptedProvider();
    const raw = JSON.stringify({ id: 'evt-2', event: 'authorised', providerRef: 'fx_x', amount: 1, currency: 'NGN', state: 'authorised' });
    const sig = new FixturePaymentProvider('s').sign(raw);
    const first = await handleWebhookDurable({ authority, provider }, raw, { 'x-fixture-signature': sig }, NOW);
    const second = await handleWebhookDurable({ authority, provider }, raw, { 'x-fixture-signature': sig }, NOW);
    assert.equal(first.status, 'applied');
    assert.equal(second.status, 'duplicate');
  });
});

describe('start-up requirements', () => {
  test('the reference for a booking is fixed by the booking alone', () => {
    assert.equal(paymentStartReference(BOOKING), paymentStartReference(BOOKING));
    assert.equal(paymentStartReference(BOOKING), `booking:${BOOKING}:payment_start:1`);
  });
});
