// Operation ledger (Phase 19.2, docs/26). Every operation with an effect outside GO's own rows (a supplier order,
// a supplier cancellation, a payment capture request, a release or a refund) is recorded here before it is attempted.
//
// Two implementations share one interface:
//   - PostgresOperationLedger (postgres-ledger.ts): the production path. It calls the database functions in
//     supabase/migrations/20261127000000_operation_ledger.sql. Lease times come from the database clock.
//   - MemoryOperationLedger (this file): a test fixture that applies the same rules in memory. It must not be used
//     by production code. A source test enforces that the execution paths do not import it.
//
// Rules, in order of importance:
//   1. One key, one operation. (operation type, idempotency key) is unique. A repeat with the same key returns the
//      existing operation; it never creates another. A repeat with the same key and a different request is refused.
//   2. One live operation per subject. For every type except booking.create, at most one operation per subject
//      (booking or payment) may be in_progress, succeeded or unknown. A second key for the same subject is refused.
//   3. Leases and fencing. A worker holds a lease while it works. Only the holder may complete an operation. A stale
//      worker's completion is recorded and rejected, and changes nothing.
//   4. Interrupted external work is never retried blindly. If a lease expires on an external operation, the outcome is
//      unknown (the effect may have happened). It moves to unknown and waits for reconciliation with evidence.
//      Internal operations (booking.create) run in one database transaction, so an interrupted attempt changed nothing
//      and may be taken over.
//   5. Every attempt is recorded, append-only, with the actor and correlation reference. Failure details carry codes,
//      never passenger data.

import { createHash } from 'node:crypto';

export const OPERATION_TYPES = [
  'booking.create',
  'supplier.order',
  'supplier.cancel',
  'payment.start',
  'payment.capture_request',
  'payment.release',
  'payment.refund',
] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

export const OPERATION_STATUSES = ['in_progress', 'succeeded', 'failed_retryable', 'failed_terminal', 'unknown'] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const EXTERNAL_OPERATION_TYPES: readonly OperationType[] = [
  'supplier.order',
  'supplier.cancel',
  'payment.start',
  'payment.capture_request',
  'payment.release',
  'payment.refund',
];

// A status that holds the subject: a second operation for the same subject is refused while one is live.
export const LIVE_STATUSES: readonly OperationStatus[] = ['in_progress', 'succeeded', 'unknown'];

export const OPERATION_TRANSITIONS: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  in_progress: ['succeeded', 'failed_retryable', 'failed_terminal', 'unknown'],
  failed_retryable: ['in_progress'],
  unknown: ['succeeded', 'failed_retryable', 'failed_terminal'],
  succeeded: [],
  failed_terminal: [],
};

export const LEASE_SECONDS_MIN = 1;
export const LEASE_SECONDS_MAX = 3600;

export const ATTEMPT_EVENTS = [
  'started',
  'lease_taken_over',
  'lease_expired_unknown',
  'succeeded',
  'failed_retryable',
  'failed_terminal',
  'unknown',
  'stale_completion_rejected',
  'reconciled_succeeded',
  'reconciled_failed_retryable',
  'reconciled_failed_terminal',
] as const;
export type AttemptEvent = (typeof ATTEMPT_EVENTS)[number];

export function isExternal(type: OperationType): boolean {
  return EXTERNAL_OPERATION_TYPES.includes(type);
}

export function subjectIsUnique(type: OperationType): boolean {
  return type !== 'booking.create';
}

// A stable fingerprint of a request. The same key with a different fingerprint is a key reuse, and is refused.
export function requestFingerprint(canonical: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface OperationRow {
  readonly id: string;
  readonly operationType: OperationType;
  readonly idempotencyKey: string;
  readonly subjectBookingId: string | null;
  readonly subjectRef: string;
  readonly status: OperationStatus;
  readonly requestFingerprint: string;
  readonly attemptCount: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAtUtc: string | null;
  readonly resultRef: string | null;
  readonly failureCode: string | null;
  readonly actorKind: 'backend_workflow' | 'provider_event' | 'reconciliation';
  readonly actorLabel: string;
  readonly correlationId: string;
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
  readonly completedAtUtc: string | null;
}

export interface AttemptRecord {
  readonly operationId: string;
  readonly attemptNo: number;
  readonly event: AttemptEvent;
  readonly owner: string | null;
  readonly failureCode: string | null;
  readonly correlationId: string;
  readonly occurredAtUtc: string;
}

// Lease times are never supplied by the caller. The database (or the memory fixture's clock) decides them.
export interface BeginInput {
  readonly operationType: OperationType;
  readonly idempotencyKey: string;
  readonly subjectRef: string;
  readonly fingerprint: string;
  readonly actorLabel: string;
  readonly correlationId: string;
  readonly owner: string;
  readonly leaseSeconds: number;
}

export type BeginDecision =
  | { readonly decision: 'started'; readonly operationId: string; readonly attemptNo: number; readonly takeover: boolean }
  | { readonly decision: 'already_succeeded'; readonly operationId: string; readonly resultRef: string }
  | { readonly decision: 'in_progress'; readonly operationId: string }
  | { readonly decision: 'needs_reconciliation'; readonly operationId: string }
  | { readonly decision: 'terminal_failure'; readonly operationId: string; readonly failureCode: string | null }
  | { readonly decision: 'key_reused'; readonly operationId: string }
  | { readonly decision: 'subject_busy'; readonly operationId: string }
  | { readonly decision: 'refused'; readonly reason: string };

export type CompleteOutcome =
  | { readonly outcome: 'succeeded'; readonly resultRef: string }
  | { readonly outcome: 'failed_retryable' | 'failed_terminal' | 'unknown'; readonly failureCode: string };

export type ReconcileOutcome =
  | { readonly outcome: 'succeeded'; readonly resultRef: string; readonly evidenceRef: string }
  | { readonly outcome: 'failed_retryable' | 'failed_terminal'; readonly failureCode: string; readonly evidenceRef: string };

// The execution paths depend only on this interface. Every method may touch durable storage, so all are asynchronous.
export interface OperationLedger {
  begin(input: BeginInput): Promise<BeginDecision>;
  complete(operationId: string, owner: string, outcome: CompleteOutcome, correlationId: string): Promise<'completed' | 'rejected_stale'>;
  renewLease(operationId: string, owner: string, leaseSeconds: number): Promise<boolean>;
  reconcile(operationId: string, outcome: ReconcileOutcome, actorLabel: string, correlationId: string): Promise<'reconciled' | 'refused'>;
  byKey(type: OperationType, key: string): Promise<OperationRow | undefined>;
  attempts(operationId: string): Promise<readonly AttemptRecord[]>;
}

export function assertTransition(from: OperationStatus, to: OperationStatus): void {
  if (!OPERATION_TRANSITIONS[from].includes(to)) throw new RangeError(`Illegal operation transition ${from} -> ${to}`);
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

interface LogEntry extends AttemptRecord {}

// TEST FIXTURE ONLY. Applies the same rules as the database functions, in memory, with an injected clock.
// It loses its state when the process exits, so it cannot protect a real restart. Production code must use
// PostgresOperationLedger.
export class MemoryOperationLedger implements OperationLedger {
  private readonly rows = new Map<string, OperationRow>();
  private readonly byKeyMap = new Map<string, string>();
  private readonly log: LogEntry[] = [];
  private sequence = 0;

  private readonly clock: () => string;

  constructor(clock: () => string = () => new Date().toISOString()) {
    this.clock = clock;
  }

  async begin(input: BeginInput): Promise<BeginDecision> {
    return this.beginNow(input);
  }

  async complete(operationId: string, owner: string, outcome: CompleteOutcome, correlationId: string): Promise<'completed' | 'rejected_stale'> {
    return this.completeNow(operationId, owner, outcome, correlationId);
  }

  async renewLease(operationId: string, owner: string, leaseSeconds: number): Promise<boolean> {
    const row = this.rows.get(operationId);
    const now = this.clock();
    if (!row || row.status !== 'in_progress' || row.leaseOwner !== owner) return false;
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < LEASE_SECONDS_MIN || leaseSeconds > LEASE_SECONDS_MAX) return false;
    this.setRow(operationId, { leaseExpiresAtUtc: addSeconds(now, leaseSeconds), updatedAtUtc: now });
    return true;
  }

  async reconcile(operationId: string, outcome: ReconcileOutcome, actorLabel: string, correlationId: string): Promise<'reconciled' | 'refused'> {
    const row = this.rows.get(operationId);
    const now = this.clock();
    if (!row || row.status !== 'unknown') return 'refused';
    if (!actorLabel.startsWith('reconciliation:') || !outcome.evidenceRef.trim()) return 'refused';
    assertTransition('unknown', outcome.outcome);
    if (outcome.outcome === 'succeeded') {
      this.setRow(operationId, { status: 'succeeded', resultRef: outcome.resultRef, failureCode: null, completedAtUtc: now, updatedAtUtc: now, actorKind: 'reconciliation', actorLabel });
      this.record(operationId, row.attemptCount, 'reconciled_succeeded', null, null, correlationId, now);
    } else {
      const terminal = outcome.outcome === 'failed_terminal';
      this.setRow(operationId, { status: outcome.outcome, failureCode: outcome.failureCode, completedAtUtc: terminal ? now : null, updatedAtUtc: now, actorKind: 'reconciliation', actorLabel });
      this.record(operationId, row.attemptCount, terminal ? 'reconciled_failed_terminal' : 'reconciled_failed_retryable', null, outcome.failureCode, correlationId, now);
    }
    return 'reconciled';
  }

  // Test helper: the fixture can look up a row by its identifier. The interface does not expose this.
  async get(operationId: string): Promise<OperationRow | undefined> {
    return this.rows.get(operationId);
  }

  async byKey(type: OperationType, key: string): Promise<OperationRow | undefined> {
    const id = this.byKeyMap.get(`${type}|${key}`);
    return id ? this.rows.get(id) : undefined;
  }

  async attempts(operationId: string): Promise<readonly AttemptRecord[]> {
    return this.log.filter((a) => a.operationId === operationId);
  }

  private beginNow(input: BeginInput): BeginDecision {
    const now = this.clock();
    if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < LEASE_SECONDS_MIN || input.leaseSeconds > LEASE_SECONDS_MAX) {
      return { decision: 'refused', reason: 'lease out of range' };
    }
    if (!input.idempotencyKey.trim() || !input.owner.trim()) return { decision: 'refused', reason: 'key and owner are required' };

    const existingId = this.byKeyMap.get(`${input.operationType}|${input.idempotencyKey}`);
    if (existingId) {
      const row = this.rows.get(existingId) as OperationRow;
      if (row.requestFingerprint !== input.fingerprint) return { decision: 'key_reused', operationId: row.id };
      return this.resume(row, input, now);
    }

    if (subjectIsUnique(input.operationType)) {
      const busy = [...this.rows.values()].find(
        (r) => r.operationType === input.operationType && r.subjectRef === input.subjectRef && LIVE_STATUSES.includes(r.status),
      );
      if (busy) return { decision: 'subject_busy', operationId: busy.id };
    }

    const id = `op_${(++this.sequence).toString().padStart(6, '0')}`;
    const row: OperationRow = {
      id,
      operationType: input.operationType,
      idempotencyKey: input.idempotencyKey,
      subjectBookingId: null,
      subjectRef: input.subjectRef,
      status: 'in_progress',
      requestFingerprint: input.fingerprint,
      attemptCount: 1,
      leaseOwner: input.owner,
      leaseExpiresAtUtc: addSeconds(now, input.leaseSeconds),
      resultRef: null,
      failureCode: null,
      actorKind: 'backend_workflow',
      actorLabel: input.actorLabel,
      correlationId: input.correlationId,
      createdAtUtc: now,
      updatedAtUtc: now,
      completedAtUtc: null,
    };
    this.rows.set(id, row);
    this.byKeyMap.set(`${input.operationType}|${input.idempotencyKey}`, id);
    this.record(id, 1, 'started', input.owner, null, input.correlationId, now);
    return { decision: 'started', operationId: id, attemptNo: 1, takeover: false };
  }

  private resume(row: OperationRow, input: BeginInput, now: string): BeginDecision {
    switch (row.status) {
      case 'succeeded':
        return { decision: 'already_succeeded', operationId: row.id, resultRef: row.resultRef as string };
      case 'failed_terminal':
        return { decision: 'terminal_failure', operationId: row.id, failureCode: row.failureCode };
      case 'unknown':
        return { decision: 'needs_reconciliation', operationId: row.id };
      case 'in_progress': {
        const leaseLive = Date.parse(row.leaseExpiresAtUtc as string) > Date.parse(now);
        if (leaseLive) return { decision: 'in_progress', operationId: row.id };
        if (isExternal(row.operationType)) {
          this.setRow(row.id, { status: 'unknown', leaseOwner: null, leaseExpiresAtUtc: null, failureCode: 'lease_expired', updatedAtUtc: now });
          this.record(row.id, row.attemptCount, 'lease_expired_unknown', row.leaseOwner, 'lease_expired', input.correlationId, now);
          return { decision: 'needs_reconciliation', operationId: row.id };
        }
        const attemptNo = row.attemptCount + 1;
        this.setRow(row.id, { leaseOwner: input.owner, leaseExpiresAtUtc: addSeconds(now, input.leaseSeconds), attemptCount: attemptNo, updatedAtUtc: now });
        this.record(row.id, attemptNo, 'lease_taken_over', input.owner, null, input.correlationId, now);
        return { decision: 'started', operationId: row.id, attemptNo, takeover: true };
      }
      case 'failed_retryable': {
        const attemptNo = row.attemptCount + 1;
        assertTransition('failed_retryable', 'in_progress');
        this.setRow(row.id, {
          status: 'in_progress',
          leaseOwner: input.owner,
          leaseExpiresAtUtc: addSeconds(now, input.leaseSeconds),
          attemptCount: attemptNo,
          failureCode: null,
          updatedAtUtc: now,
        });
        this.record(row.id, attemptNo, 'started', input.owner, null, input.correlationId, now);
        return { decision: 'started', operationId: row.id, attemptNo, takeover: false };
      }
    }
  }

  private completeNow(operationId: string, owner: string, outcome: CompleteOutcome, correlationId: string): 'completed' | 'rejected_stale' {
    const row = this.rows.get(operationId);
    const now = this.clock();
    if (!row) throw new RangeError('Unknown operation');
    if (row.status !== 'in_progress' || row.leaseOwner !== owner) {
      this.record(operationId, row.attemptCount, 'stale_completion_rejected', owner, null, correlationId, now);
      return 'rejected_stale';
    }
    if (outcome.outcome === 'succeeded') {
      if (!outcome.resultRef.trim()) throw new RangeError('A succeeded operation needs a result reference');
      assertTransition('in_progress', 'succeeded');
      this.setRow(operationId, { status: 'succeeded', resultRef: outcome.resultRef, leaseOwner: null, leaseExpiresAtUtc: null, completedAtUtc: now, updatedAtUtc: now });
      this.record(operationId, row.attemptCount, 'succeeded', owner, null, correlationId, now);
    } else {
      if (!outcome.failureCode.trim()) throw new RangeError('A failure needs a failure code');
      assertTransition('in_progress', outcome.outcome);
      const terminal = outcome.outcome === 'failed_terminal';
      this.setRow(operationId, {
        status: outcome.outcome,
        failureCode: outcome.failureCode,
        leaseOwner: null,
        leaseExpiresAtUtc: null,
        completedAtUtc: terminal ? now : null,
        updatedAtUtc: now,
      });
      this.record(operationId, row.attemptCount, outcome.outcome, owner, outcome.failureCode, correlationId, now);
    }
    return 'completed';
  }

  private record(operationId: string, attemptNo: number, event: AttemptEvent, owner: string | null, failureCode: string | null, correlationId: string, at: string): void {
    this.log.push({ operationId, attemptNo, event, owner, failureCode, correlationId, occurredAtUtc: at });
  }

  private setRow(id: string, patch: Partial<OperationRow>): void {
    this.rows.set(id, { ...(this.rows.get(id) as OperationRow), ...patch });
  }
}
