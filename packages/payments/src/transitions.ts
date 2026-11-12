// The one place where an intent's status changes. Every change is validated against the
// transition table and written to the audit log, so the log and the state cannot drift.

import type { PaymentIntent } from './intent.ts';
import type { PaymentStore } from './store.ts';
import { transition, type PaymentStatus } from './state.ts';

export function moveIntent(
  store: PaymentStore,
  intent: PaymentIntent,
  to: PaymentStatus,
  event: string,
  nowUtc: string,
  detail: string,
  patch: Partial<Pick<PaymentIntent, 'providerRef' | 'capturedMinor' | 'refundedMinor'>> = {},
): PaymentIntent {
  const next = transition(intent.status, to);
  const updated: PaymentIntent = { ...intent, ...patch, status: next };
  store.saveIntent(updated);
  store.append({ at: nowUtc, intentId: intent.id, event, from: intent.status, to: next, detail });
  return updated;
}
