// Provider-independent payment interface. The booking and payment flow depends only on
// this file. Adapters (Paystack, Flutterwave, fixture) implement it. No provider SDK types
// leak past an adapter.
//
// Capabilities are declared with evidence. A capability is 'supported' only when the
// provider's own documentation or written confirmation says so. Anything else is
// 'unconfirmed' or 'not_supported', and the flow refuses to rely on it.

import type { Money } from '../../core/src/money.ts';

export type Capability = 'supported' | 'unconfirmed' | 'not_supported';

export interface ProviderCapabilities {
  readonly authorisation: Capability; // hold funds now, capture later
  readonly capture: Capability;
  readonly release: Capability; // cancel a hold without charging
  readonly refund: Capability;
  readonly bankTransfer: Capability;
  readonly webhookSignature: Capability;
  readonly evidence: Readonly<Record<string, string>>; // where each claim came from
}

export interface InitiateRequest {
  readonly reference: string; // our reference, also used as the provider idempotency key
  readonly amount: Money;
  readonly customerEmail: string;
  readonly expiresAtUtc: string;
  readonly mode: 'authorise' | 'charge';
}

export interface InitiateResult {
  readonly providerRef: string;
  readonly redirectUrl: string;
}

// What the provider itself reports when asked. Webhook bodies are never trusted on their own.
export interface ProviderStatus {
  readonly state: 'pending' | 'authorised' | 'captured' | 'failed' | 'released' | 'refunded';
  readonly amount: Money;
}

export interface WebhookVerification {
  readonly valid: boolean;
}

export interface ParsedWebhook {
  readonly eventName: string;
  readonly providerRef: string;
  readonly reportedAmountMinor: number;
  readonly reportedCurrency: string;
  readonly reportedState: 'authorised' | 'captured' | 'failed' | 'other';
}

export interface PaymentProvider {
  readonly name: string;
  readonly mode: 'fixture' | 'sandbox' | 'production';
  readonly capabilities: ProviderCapabilities;
  initiate(request: InitiateRequest): Promise<InitiateResult>;
  getStatus(providerRef: string): Promise<ProviderStatus>;
  capture?(providerRef: string, amount: Money, idempotencyKey: string): Promise<ProviderStatus>;
  release?(providerRef: string, idempotencyKey: string): Promise<ProviderStatus>;
  refund?(providerRef: string, amount: Money, idempotencyKey: string): Promise<ProviderStatus>;
  verifyWebhook(rawBody: string, headers: Readonly<Record<string, string | undefined>>): WebhookVerification;
  parseWebhook(rawBody: string): ParsedWebhook;
}

export class PaymentProviderError extends Error {
  readonly reason: 'not_configured' | 'not_supported' | 'provider_error' | 'timeout' | 'invalid_response';

  constructor(reason: PaymentProviderError['reason'], message: string) {
    super(message);
    this.name = 'PaymentProviderError';
    this.reason = reason;
  }
}
