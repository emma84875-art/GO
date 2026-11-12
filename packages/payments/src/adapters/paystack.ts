// Paystack adapter. STATUS: webhook verification is implemented from Paystack's documented
// method. Authorisation (pre-authorisation) is NOT offered for this merchant: Paystack's
// documentation says it is ZAR-only, for South African registered businesses, and not
// enabled by default. Paystack has not confirmed NGN pre-authorisation in writing.
// Endpoint paths other than webhook handling were not verified in this session. They must be
// checked in the Paystack sandbox before use.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Money } from '../../../core/src/money.ts';
import { PaymentProviderError, type InitiateRequest, type ParsedWebhook, type PaymentProvider, type ProviderCapabilities, type ProviderStatus } from '../provider.ts';

export const PAYSTACK_SIGNATURE_HEADER = 'x-paystack-signature';
export const PAYSTACK_API = 'https://api.paystack.co';

export type Transport = (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface PaystackConfig {
  readonly mode: 'sandbox' | 'production';
  readonly secretKey?: string;
  readonly productionApproved?: boolean;
  readonly transport?: Transport;
}

const CAPABILITIES: ProviderCapabilities = {
  authorisation: 'unconfirmed',
  capture: 'unconfirmed',
  release: 'unconfirmed',
  refund: 'unconfirmed',
  bankTransfer: 'unconfirmed',
  webhookSignature: 'supported',
  evidence: {
    authorisation: 'Paystack pre-authorisation docs: ZAR only, SA-registered businesses, not enabled by default.',
    webhookSignature: 'Paystack webhook docs: x-paystack-signature, HMAC SHA512 with the secret key.',
    bankTransfer: 'Not checked against Paystack documentation for NGN in this session.',
  },
};

export class PaystackPaymentProvider implements PaymentProvider {
  readonly name = 'paystack';
  readonly mode: 'sandbox' | 'production';
  readonly capabilities = CAPABILITIES;
  private readonly config: PaystackConfig;

  constructor(config: PaystackConfig) {
    this.config = config;
    this.mode = config.mode;
  }

  // Signature over the raw body. A re-serialised JSON object would change the bytes and fail.
  verifyWebhook(rawBody: string, headers: Readonly<Record<string, string | undefined>>) {
    if (!this.config.secretKey) return { valid: false };
    const given = headers[PAYSTACK_SIGNATURE_HEADER] ?? '';
    const expected = createHmac('sha512', this.config.secretKey).update(rawBody).digest('hex');
    if (given.length !== expected.length) return { valid: false };
    return { valid: timingSafeEqual(Buffer.from(given), Buffer.from(expected)) };
  }

  parseWebhook(rawBody: string): ParsedWebhook {
    const body = JSON.parse(rawBody) as { event?: string; data?: { reference?: string; amount?: number; currency?: string; status?: string } };
    const data = body.data;
    if (!body.event || !data?.reference || !Number.isSafeInteger(data.amount) || !data.currency) {
      throw new PaymentProviderError('invalid_response', 'Paystack webhook is missing fields');
    }
    // Paystack amounts are in the currency's minor unit (kobo for NGN), matching our model.
    return {
      eventName: body.event,
      providerRef: data.reference,
      reportedAmountMinor: data.amount as number,
      reportedCurrency: data.currency,
      reportedState: body.event === 'charge.success' ? 'captured' : body.event === 'charge.failed' ? 'failed' : 'other',
    };
  }

  async initiate(request: InitiateRequest) {
    if (request.mode === 'authorise') {
      throw new PaymentProviderError('not_supported', 'Paystack authorisation is not confirmed for this merchant. Payment is not started.');
    }
    const transport = this.requireTransport();
    const response = await transport(`${PAYSTACK_API}/transaction/initialize`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ email: request.customerEmail, amount: request.amount.amountMinor, currency: request.amount.currency, reference: request.reference }),
    });
    if (response.status >= 400) throw new PaymentProviderError('provider_error', `Paystack returned HTTP ${response.status}`);
    const body = (await response.json()) as { data?: { reference?: string; authorization_url?: string } };
    if (!body.data?.reference || !body.data.authorization_url) throw new PaymentProviderError('invalid_response', 'Paystack initialise response is incomplete');
    return { providerRef: body.data.reference, redirectUrl: body.data.authorization_url };
  }

  async getStatus(providerRef: string): Promise<ProviderStatus> {
    const transport = this.requireTransport();
    const response = await transport(`${PAYSTACK_API}/transaction/verify/${encodeURIComponent(providerRef)}`, { method: 'GET', headers: this.headers() });
    if (response.status >= 400) throw new PaymentProviderError('provider_error', `Paystack returned HTTP ${response.status}`);
    const body = (await response.json()) as { data?: { status?: string; amount?: number; currency?: string } };
    const data = body.data;
    if (!data || !Number.isSafeInteger(data.amount) || !data.currency) throw new PaymentProviderError('invalid_response', 'Paystack verify response is incomplete');
    const state: ProviderStatus['state'] = data.status === 'success' ? 'captured' : data.status === 'failed' ? 'failed' : 'pending';
    return { state, amount: { amountMinor: data.amount as number, currency: data.currency as Money['currency'] } };
  }

  private requireTransport(): Transport {
    if (!this.config.secretKey) throw new PaymentProviderError('not_configured', 'Paystack secret key is not configured');
    if (this.config.mode === 'production' && this.config.productionApproved !== true) {
      throw new PaymentProviderError('not_supported', 'Paystack production is not approved');
    }
    if (!this.config.transport) throw new PaymentProviderError('not_configured', 'No HTTP transport injected');
    return this.config.transport;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.secretKey}`, 'Content-Type': 'application/json' };
  }
}
