// Flutterwave adapter. STATUS: webhook verification implemented from Flutterwave's documented
// method (static secret hash in the verif-hash header, compared in constant time).
// Pre-authorisation exists in Flutterwave's documentation (preauthorize flag, capture and void
// endpoints) but is NOT enabled by default and needs support enablement. NGN is not listed as
// a supported currency in that documentation. So authorisation stays 'unconfirmed' and
// initiation in authorise mode is refused. Charge mode is not built yet.

import { timingSafeEqual } from 'node:crypto';
import { PaymentProviderError, type InitiateRequest, type ParsedWebhook, type PaymentProvider, type ProviderCapabilities, type ProviderStatus } from '../provider.ts';

export const FLUTTERWAVE_HASH_HEADER = 'verif-hash';
export const FLUTTERWAVE_API = 'https://api.flutterwave.com/v3';

const CAPABILITIES: ProviderCapabilities = {
  authorisation: 'unconfirmed',
  capture: 'unconfirmed',
  release: 'unconfirmed',
  refund: 'unconfirmed',
  bankTransfer: 'unconfirmed',
  webhookSignature: 'supported',
  evidence: {
    authorisation: 'Flutterwave pre-auth docs: off by default, needs support; NGN not listed as supported.',
    capture: 'POST /v3/charges/{ref}/capture documented; merchant access still required.',
    release: 'POST /v3/charges/{ref}/void documented; example incomplete.',
    webhookSignature: 'Flutterwave webhook docs: verif-hash header matched to a static secret hash.',
  },
};

export class FlutterwavePaymentProvider implements PaymentProvider {
  readonly name = 'flutterwave';
  readonly mode: 'sandbox' | 'production';
  readonly capabilities = CAPABILITIES;
  private readonly secretHash?: string;

  constructor(config: { mode: 'sandbox' | 'production'; secretHash?: string }) {
    this.mode = config.mode;
    this.secretHash = config.secretHash;
  }

  verifyWebhook(_rawBody: string, headers: Readonly<Record<string, string | undefined>>) {
    if (!this.secretHash) return { valid: false }; // refuse everything when unset
    const given = headers[FLUTTERWAVE_HASH_HEADER] ?? '';
    if (given.length !== this.secretHash.length) return { valid: false };
    return { valid: timingSafeEqual(Buffer.from(given), Buffer.from(this.secretHash)) };
  }

  parseWebhook(rawBody: string): ParsedWebhook {
    const body = JSON.parse(rawBody) as { event?: string; data?: { flw_ref?: string; amount?: number; currency?: string; status?: string } };
    const data = body.data;
    if (!body.event || !data?.flw_ref || !Number.isSafeInteger(data.amount) || !data.currency) {
      throw new PaymentProviderError('invalid_response', 'Flutterwave webhook is missing fields');
    }
    return {
      eventName: body.event,
      providerRef: data.flw_ref,
      reportedAmountMinor: data.amount as number,
      reportedCurrency: data.currency,
      reportedState: body.event === 'charge.completed' && data.status === 'successful' ? 'captured' : 'other',
    };
  }

  async initiate(request: InitiateRequest) {
    throw new PaymentProviderError(
      'not_supported',
      `Flutterwave ${request.mode} is not confirmed for this merchant. Payment is not started. (${FLUTTERWAVE_API})`,
    );
  }

  async getStatus(_providerRef: string): Promise<ProviderStatus> {
    throw new PaymentProviderError('not_configured', 'Flutterwave status lookup is not built until sandbox access is confirmed');
  }
}
