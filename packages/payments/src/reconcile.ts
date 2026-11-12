// Reconciliation: compare our intents with what each provider reports. It only reports.
// It never changes state, so a discrepancy always goes to a person.

import type { PaymentProvider } from './provider.ts';
import type { PaymentStore } from './store.ts';
import type { PaymentStatus } from './state.ts';

export interface Discrepancy {
  readonly intentId: string;
  readonly providerRef: string | null;
  readonly local: PaymentStatus;
  readonly providerState: string | 'unreachable' | 'no_provider_ref';
  readonly kind: 'state_mismatch' | 'amount_mismatch' | 'unreachable' | 'missing_provider_ref';
}

const LOCAL_TO_PROVIDER: Partial<Record<PaymentStatus, readonly string[]>> = {
  authorised: ['authorised'],
  captured: ['captured'],
  refund_pending: ['captured', 'refunded'],
  refunded: ['refunded'],
  released: ['released'],
  failed: ['failed'],
};

export async function reconcile(store: PaymentStore, providers: readonly PaymentProvider[]): Promise<readonly Discrepancy[]> {
  const found: Discrepancy[] = [];
  for (const intent of store.allIntents()) {
    if (intent.status === 'review_required') continue; // already flagged for a person
    if (!intent.providerRef) {
      found.push({ intentId: intent.id, providerRef: null, local: intent.status, providerState: 'no_provider_ref', kind: 'missing_provider_ref' });
      continue;
    }
    const provider = providers.find((p) => p.name === intent.provider);
    if (!provider) {
      found.push({ intentId: intent.id, providerRef: intent.providerRef, local: intent.status, providerState: 'unreachable', kind: 'unreachable' });
      continue;
    }
    try {
      const truth = await provider.getStatus(intent.providerRef);
      if (truth.amount.amountMinor !== intent.amount.amountMinor || truth.amount.currency !== intent.amount.currency) {
        found.push({ intentId: intent.id, providerRef: intent.providerRef, local: intent.status, providerState: truth.state, kind: 'amount_mismatch' });
        continue;
      }
      const expected = LOCAL_TO_PROVIDER[intent.status];
      if (expected && !expected.includes(truth.state)) {
        found.push({ intentId: intent.id, providerRef: intent.providerRef, local: intent.status, providerState: truth.state, kind: 'state_mismatch' });
      }
    } catch {
      found.push({ intentId: intent.id, providerRef: intent.providerRef, local: intent.status, providerState: 'unreachable', kind: 'unreachable' });
    }
  }
  return found;
}
