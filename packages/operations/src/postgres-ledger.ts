// The production operation ledger (Phase 19.2, docs/26). It calls the database functions created by
// supabase/migrations/20261127000000_operation_ledger.sql and returns their decisions unchanged.
//
// What this module does not do, by design:
//   - It never decides a lease, an expiry or an outcome itself. The database decides, with its own clock.
//   - It never reads the ledger to make a decision. Reads are for reconciliation and tests only.
//   - It never retries a database call that might have changed state. A failed call throws, and the caller treats
//     the operation as not started (for begin) or left in progress (for complete), which the database then resolves
//     when the lease expires.
//
// Values are placed in SQL as literals. Every string is quoted with doubled single quotes, and NUL bytes are refused.
// Inputs are checked for type and range before they reach SQL, and the database checks them again.

import type {
  AttemptRecord,
  BeginDecision,
  BeginInput,
  CompleteOutcome,
  OperationLedger,
  OperationRow,
  OperationType,
  ReconcileOutcome,
} from './ledger.ts';
import { LEASE_SECONDS_MAX, LEASE_SECONDS_MIN, OPERATION_TYPES } from './ledger.ts';
import { LedgerDatabaseError, type SqlExecutor } from './sql-executor.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function sqlText(value: string): string {
  if (value.includes('\0')) throw new RangeError('NUL bytes are not allowed in ledger values');
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlNullableText(value: string | null): string {
  return value === null ? 'null' : sqlText(value);
}

function sqlInteger(value: number): string {
  if (!Number.isInteger(value)) throw new RangeError('Expected an integer');
  return String(value);
}

function sqlUuid(value: string): string {
  if (!UUID.test(value)) throw new RangeError('Expected a UUID');
  return `'${value}'::uuid`;
}

function requireType(type: OperationType): void {
  if (!OPERATION_TYPES.includes(type)) throw new RangeError('Unknown operation type');
}

interface DecisionJson {
  decision: BeginDecision['decision'];
  operation_id?: string;
  attempt_no?: number;
  takeover?: boolean;
  result_ref?: string;
  failure_code?: string | null;
  reason?: string;
}

function parseDecision(text: string): BeginDecision {
  const j = JSON.parse(text) as DecisionJson;
  const id = j.operation_id ?? '';
  switch (j.decision) {
    case 'started':
      return { decision: 'started', operationId: id, attemptNo: j.attempt_no as number, takeover: j.takeover === true };
    case 'already_succeeded':
      return { decision: 'already_succeeded', operationId: id, resultRef: j.result_ref as string };
    case 'in_progress':
    case 'needs_reconciliation':
    case 'key_reused':
    case 'subject_busy':
      return { decision: j.decision, operationId: id };
    case 'terminal_failure':
      return { decision: 'terminal_failure', operationId: id, failureCode: j.failure_code ?? null };
    case 'refused':
      return { decision: 'refused', reason: j.reason ?? 'refused' };
    default:
      throw new LedgerDatabaseError('unexpected_decision', 'The database returned an unknown decision.');
  }
}

export class PostgresOperationLedger implements OperationLedger {
  private readonly sql: SqlExecutor;

  constructor(sql: SqlExecutor) {
    this.sql = sql;
  }

  async begin(input: BeginInput): Promise<BeginDecision> {
    requireType(input.operationType);
    sqlInteger(input.leaseSeconds);
    const statement = `select public.begin_operation(${sqlText(input.operationType)}, ${sqlText(input.idempotencyKey)}, null, ${sqlText(input.subjectRef)}, ${sqlText(input.fingerprint)}, ${sqlText(input.actorLabel)}, ${sqlText(input.correlationId)}, ${sqlText(input.owner)}, ${sqlInteger(input.leaseSeconds)})::text;`;
    const out = await this.sql(statement);
    return parseDecision(out);
  }

  async complete(operationId: string, owner: string, outcome: CompleteOutcome, correlationId: string): Promise<'completed' | 'rejected_stale'> {
    const result = outcome.outcome === 'succeeded' ? outcome.resultRef : null;
    const failure = outcome.outcome === 'succeeded' ? null : outcome.failureCode;
    const statement = `select public.complete_operation(${sqlUuid(operationId)}, ${sqlText(owner)}, ${sqlText(outcome.outcome)}, ${sqlNullableText(result)}, ${sqlNullableText(failure)}, ${sqlText(correlationId)})::text;`;
    const out = await this.sql(statement);
    if (out !== 'completed' && out !== 'rejected_stale') throw new LedgerDatabaseError('unexpected_result', 'The database returned an unknown completion result.');
    return out;
  }

  async renewLease(operationId: string, owner: string, leaseSeconds: number): Promise<boolean> {
    if (leaseSeconds < LEASE_SECONDS_MIN || leaseSeconds > LEASE_SECONDS_MAX) return false;
    const out = await this.sql(`select public.renew_operation_lease(${sqlUuid(operationId)}, ${sqlText(owner)}, ${sqlInteger(leaseSeconds)})::text;`);
    return out === 'true';
  }

  async reconcile(operationId: string, outcome: ReconcileOutcome, actorLabel: string, correlationId: string): Promise<'reconciled' | 'refused'> {
    const result = outcome.outcome === 'succeeded' ? outcome.resultRef : null;
    const failure = outcome.outcome === 'succeeded' ? null : outcome.failureCode;
    const statement = `select public.reconcile_operation(${sqlUuid(operationId)}, ${sqlText(outcome.outcome)}, ${sqlNullableText(result)}, ${sqlNullableText(failure)}, ${sqlText(outcome.evidenceRef)}, ${sqlText(actorLabel)}, ${sqlText(correlationId)})::text;`;
    const out = await this.sql(statement);
    if (out !== 'reconciled' && out !== 'refused') throw new LedgerDatabaseError('unexpected_result', 'The database returned an unknown reconciliation result.');
    return out;
  }

  async byKey(type: OperationType, key: string): Promise<OperationRow | undefined> {
    requireType(type);
    const statement = `select coalesce((select row_to_json(r)::text from (
        select id, operation_type as "operationType", idempotency_key as "idempotencyKey", subject_booking_id as "subjectBookingId",
               subject_ref as "subjectRef", status, request_fingerprint as "requestFingerprint", attempt_count as "attemptCount",
               lease_owner as "leaseOwner", lease_expires_at as "leaseExpiresAtUtc", result_ref as "resultRef",
               failure_code as "failureCode", actor_kind as "actorKind", actor_label as "actorLabel",
               correlation_id as "correlationId", created_at as "createdAtUtc", updated_at as "updatedAtUtc",
               completed_at as "completedAtUtc"
        from public.operation_ledger where operation_type = ${sqlText(type)} and idempotency_key = ${sqlText(key)}) r), '');`;
    const out = await this.sql(statement);
    return out === '' ? undefined : (JSON.parse(out) as OperationRow);
  }

  async attempts(operationId: string): Promise<readonly AttemptRecord[]> {
    if (!UUID.test(operationId)) throw new RangeError('Expected a UUID');
    const statement = `select coalesce(json_agg(x)::text, '[]') from (
        select operation_id as "operationId", attempt_no as "attemptNo", event, lease_owner as owner,
               failure_code as "failureCode", correlation_id as "correlationId", occurred_at as "occurredAtUtc"
        from public.operation_attempts where operation_id = ${sqlUuid(operationId)} order by id) x;`;
    const out = await this.sql(statement);
    return JSON.parse(out) as AttemptRecord[];
  }
}
