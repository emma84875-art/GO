// In-memory payment store used by the flow and tests. The database implementation must
// keep the same guarantees: append-only audit, one live intent per booking, and a unique
// webhook dedupe key. Persistence is not wired yet; see the schema and remaining-risks note.

import type { PaymentIntent } from './intent.ts';
import type { PaymentStatus } from './state.ts';

export interface AuditEntry {
  readonly at: string;
  readonly intentId: string;
  readonly event: string;
  readonly from: PaymentStatus | null;
  readonly to: PaymentStatus | null;
  readonly detail: string;
}

export class PaymentStore {
  private readonly intentsById = new Map<string, PaymentIntent>();
  private readonly processedWebhooks = new Set<string>();
  private readonly auditLog: AuditEntry[] = [];

  saveIntent(intent: PaymentIntent): void {
    this.intentsById.set(intent.id, intent);
  }

  getIntent(id: string): PaymentIntent | undefined {
    return this.intentsById.get(id);
  }

  allIntents(): readonly PaymentIntent[] {
    return [...this.intentsById.values()];
  }

  findByProviderRef(providerRef: string): PaymentIntent | undefined {
    return this.allIntents().find((intent) => intent.providerRef === providerRef);
  }

  // Returns false if the key was already processed. Webhooks use this to stay idempotent.
  markWebhookProcessed(key: string): boolean {
    if (this.processedWebhooks.has(key)) return false;
    this.processedWebhooks.add(key);
    return true;
  }

  // Synchronous claim for a payment start. Taken before any await, so a second concurrent start
  // for the same booking is refused. A database implementation needs the same guarantee, enforced
  // with a row lock or a unique partial index on live intents.
  private readonly startsInFlight = new Set<string>();

  claimPaymentStart(bookingId: string): boolean {
    if (this.startsInFlight.has(bookingId)) return false;
    this.startsInFlight.add(bookingId);
    return true;
  }

  releasePaymentStart(bookingId: string): void {
    this.startsInFlight.delete(bookingId);
  }

  // Releases a dedupe key when processing failed before any state change, so the provider's
  // retry of the same event is applied rather than treated as a duplicate.
  unmarkWebhookProcessed(key: string): void {
    this.processedWebhooks.delete(key);
  }

  append(entry: AuditEntry): void {
    this.auditLog.push(entry);
  }

  // Read-only view. The log cannot be edited or removed through this class.
  audit(): readonly AuditEntry[] {
    return [...this.auditLog];
  }
}
