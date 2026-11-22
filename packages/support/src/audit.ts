// Append-only audit log for support, cancellation and refund actions.
//
// Every attempt is recorded, including denied ones: outcome is one of allowed, denied, blocked,
// failed or succeeded. The detail field holds short codes only, never message text, passenger
// names, ticket numbers or payment details. Entries are frozen when written.

import type { AppRole } from '../../portal/src/access.ts';

export type AuditOutcome = 'denied' | 'blocked' | 'failed' | 'succeeded';

export interface AuditEntry {
  readonly seq: number;
  readonly at: string;
  readonly actorId: string;
  readonly actorRole: AppRole;
  readonly action: string;
  readonly entityType: 'support_request' | 'cancellation' | 'refund';
  readonly entityId: string;
  readonly outcome: AuditOutcome;
  readonly detail: string; // short code, for example "invalid_amount" or "gate_off"
}

export interface AuditInput {
  readonly at: string;
  readonly actorId: string;
  readonly actorRole: AppRole;
  readonly action: string;
  readonly entityType: AuditEntry['entityType'];
  readonly entityId: string;
  readonly outcome: AuditOutcome;
  readonly detail: string;
}

export class AuditLog {
  private readonly entries: AuditEntry[] = [];

  record(input: AuditInput): AuditEntry {
    const entry: AuditEntry = Object.freeze({ seq: this.entries.length + 1, ...input });
    this.entries.push(entry);
    return entry;
  }

  list(): readonly AuditEntry[] {
    return [...this.entries];
  }

  forEntity(entityId: string): readonly AuditEntry[] {
    return this.entries.filter((e) => e.entityId === entityId);
  }
}
