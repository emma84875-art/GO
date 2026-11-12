// Payment intent: one customer payment attempt for one booking. Amounts are integer minor
// units in one currency. The intent is the record of what we asked the provider to take.

import type { Money } from '../../core/src/money.ts';
import type { PaymentStatus } from './state.ts';
import { LIVE_STATUSES } from './state.ts';

export interface PaymentIntent {
  readonly id: string;
  readonly bookingId: string;
  readonly provider: string;
  readonly amount: Money;
  readonly status: PaymentStatus;
  readonly providerRef: string | null;
  readonly reference: string; // our idempotency reference sent to the provider
  readonly createdAtUtc: string;
  readonly expiresAtUtc: string;
  readonly capturedMinor: number;
  readonly refundedMinor: number;
}

export function hasLiveIntent(intents: readonly PaymentIntent[], bookingId: string): boolean {
  return intents.some((intent) => intent.bookingId === bookingId && LIVE_STATUSES.includes(intent.status));
}

export function liveIntentFor(intents: readonly PaymentIntent[], bookingId: string): PaymentIntent | undefined {
  return intents.find((intent) => intent.bookingId === bookingId && LIVE_STATUSES.includes(intent.status));
}
