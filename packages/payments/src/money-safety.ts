// Money-safety policy, enforced in code. Option A: authorise (hold the funds) first, and
// capture only after the supplier has confirmed fulfilment. Option B (capturing before
// fulfilment) is not approved and has no code path here.
//
// A capture needs every condition below. Any failed condition blocks the capture and the
// reasons are returned, so the decision is always explainable.

import type { PaymentIntent } from './intent.ts';
import type { ProviderCapabilities } from './provider.ts';

export type FulfilmentState = 'confirmed' | 'pending' | 'failed' | 'unknown';

export interface CaptureInput {
  readonly fulfilment: FulfilmentState;
  readonly bookingTotalMinor: number;
  readonly bookingCurrency: string;
  readonly capabilities: ProviderCapabilities;
  readonly nowUtc: string;
}

export interface CaptureDecision {
  readonly allowed: boolean;
  readonly reasons: readonly string[];
}

export function captureDecision(intent: PaymentIntent, input: CaptureInput): CaptureDecision {
  const reasons: string[] = [];
  if (intent.status !== 'authorised') reasons.push(`Intent is ${intent.status}, not authorised.`);
  if (input.fulfilment !== 'confirmed') reasons.push(`Supplier fulfilment is ${input.fulfilment}, not confirmed.`);
  if (intent.amount.amountMinor !== input.bookingTotalMinor || intent.amount.currency !== input.bookingCurrency) {
    reasons.push('Amount does not match the booking total.');
  }
  if (input.capabilities.capture !== 'supported') reasons.push('Provider capture is not confirmed.');
  if (Date.parse(intent.expiresAtUtc) <= Date.parse(input.nowUtc)) reasons.push('Authorisation has expired.');
  return { allowed: reasons.length === 0, reasons };
}

export function refundableMinor(intent: PaymentIntent): number {
  return Math.max(0, intent.capturedMinor - intent.refundedMinor);
}
