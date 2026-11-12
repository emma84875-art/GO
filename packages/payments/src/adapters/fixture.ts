// DEVELOPMENT FIXTURE provider. Simulates a provider so the state machine and the booking
// link can be tested. It is NOT a payment provider and moves no money. Its capabilities are
// declared as 'supported' only to exercise the flow. The UI must label it as a fixture.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Money } from '../../../core/src/money.ts';
import { PaymentProviderError, type InitiateRequest, type ParsedWebhook, type PaymentProvider, type ProviderCapabilities, type ProviderStatus } from '../provider.ts';

export const FIXTURE_WEBHOOK_HEADER = 'x-fixture-signature';

const CAPABILITIES: ProviderCapabilities = {
  authorisation: 'supported',
  capture: 'supported',
  release: 'supported',
  refund: 'supported',
  bankTransfer: 'not_supported',
  webhookSignature: 'supported',
  evidence: { all: 'development fixture, not a provider; no real evidence' },
};

export class FixturePaymentProvider implements PaymentProvider {
  readonly name = 'fixture';
  readonly mode = 'fixture' as const;
  readonly capabilities = CAPABILITIES;
  private readonly states = new Map<string, ProviderStatus>();
  private readonly secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  // Test control: the fixture's "customer" pays, fails, or the provider changes its mind.
  setState(providerRef: string, state: ProviderStatus['state'], amount?: Money): void {
    const current = this.states.get(providerRef);
    const base = amount ?? current?.amount;
    if (!base) throw new Error('setState needs an amount for an unknown reference');
    this.states.set(providerRef, { state, amount: base });
  }

  async initiate(request: InitiateRequest) {
    if (request.mode !== 'authorise') throw new PaymentProviderError('not_supported', 'Fixture supports authorise mode only');
    const providerRef = `fx_${request.reference.replace(/[^a-z0-9]+/gi, '_')}`;
    this.states.set(providerRef, { state: 'pending', amount: request.amount });
    return { providerRef, redirectUrl: `https://fixture.invalid/pay/${providerRef}` };
  }

  async getStatus(providerRef: string): Promise<ProviderStatus> {
    const status = this.states.get(providerRef);
    if (!status) throw new PaymentProviderError('provider_error', 'Unknown fixture reference');
    return status;
  }

  async capture(providerRef: string, amount: Money): Promise<ProviderStatus> {
    const current = await this.getStatus(providerRef);
    if (current.state !== 'authorised') throw new PaymentProviderError('provider_error', `Cannot capture from ${current.state}`);
    this.setState(providerRef, 'captured', amount);
    return this.getStatus(providerRef);
  }

  async release(providerRef: string): Promise<ProviderStatus> {
    const current = await this.getStatus(providerRef);
    this.setState(providerRef, 'released', current.amount);
    return this.getStatus(providerRef);
  }

  async refund(providerRef: string): Promise<ProviderStatus> {
    const current = await this.getStatus(providerRef);
    this.setState(providerRef, 'refunded', current.amount);
    return this.getStatus(providerRef);
  }

  sign(rawBody: string): string {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }

  verifyWebhook(rawBody: string, headers: Readonly<Record<string, string | undefined>>) {
    const given = headers[FIXTURE_WEBHOOK_HEADER] ?? '';
    const expected = this.sign(rawBody);
    if (given.length !== expected.length) return { valid: false };
    return { valid: timingSafeEqual(Buffer.from(given), Buffer.from(expected)) };
  }

  parseWebhook(rawBody: string): ParsedWebhook {
    const body = JSON.parse(rawBody) as { event?: string; providerRef?: string; amount?: number; currency?: string; state?: string };
    if (!body.event || !body.providerRef || !Number.isSafeInteger(body.amount) || !body.currency) {
      throw new PaymentProviderError('invalid_response', 'Fixture webhook is missing fields');
    }
    const reportedState = body.state === 'authorised' || body.state === 'captured' || body.state === 'failed' ? body.state : 'other';
    return {
      eventName: body.event,
      providerRef: body.providerRef,
      reportedAmountMinor: body.amount as number,
      reportedCurrency: body.currency,
      reportedState,
    };
  }
}
