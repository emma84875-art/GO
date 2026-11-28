// Unit checks for the PostgreSQL adapter that need no database: SQL literals, decision parsing, error handling, and
// the rule that production execution paths never import the in-memory fixture.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PostgresOperationLedger, sqlText } from '../src/postgres-ledger.ts';
import { LedgerDatabaseError, psqlExecutor } from '../src/sql-executor.ts';
import { requestFingerprint, type BeginInput } from '../src/ledger.ts';

const FP = requestFingerprint({ a: 1 });
function input(over: Partial<BeginInput> = {}): BeginInput {
  return {
    operationType: 'supplier.order', idempotencyKey: 'k', subjectRef: 'b', fingerprint: FP,
    actorLabel: 'backend:test', correlationId: 'c', owner: 'w', leaseSeconds: 60, ...over,
  };
}

// A fake executor that records statements and returns scripted answers.
function fake(answers: string[]) {
  const statements: string[] = [];
  const executor = async (sql: string) => {
    statements.push(sql);
    return answers.shift() ?? '';
  };
  return { executor, statements };
}

describe('SQL literals', () => {
  test('single quotes are doubled, so a value cannot end the literal', () => {
    assert.equal(sqlText("o'brien"), "'o''brien'");
    assert.equal(sqlText("'); drop table x; --"), "'''); drop table x; --'");
  });

  test('a NUL byte is refused before any SQL is built', () => {
    assert.throws(() => sqlText('a\0b'), RangeError);
  });
});

describe('begin', () => {
  test('the statement calls begin_operation with quoted values and no caller clock', async () => {
    const { executor, statements } = fake(['{"decision":"started","operation_id":"op-1","attempt_no":1,"takeover":false}']);
    const d = await new PostgresOperationLedger(executor).begin(input({ idempotencyKey: "it's" }));
    assert.deepEqual(d, { decision: 'started', operationId: 'op-1', attemptNo: 1, takeover: false });
    assert.match(statements[0], /select public\.begin_operation\('supplier\.order', 'it''s', null, 'b', '[0-9a-f]{64}', 'backend:test', 'c', 'w', 60\)::text;/);
    assert.doesNotMatch(statements[0], /now|timestamp|nowUtc/i, 'lease time is decided by the database');
  });

  test('every decision the database can return is mapped', async () => {
    const cases: [string, object][] = [
      ['{"decision":"already_succeeded","operation_id":"o","result_ref":"R"}', { decision: 'already_succeeded', operationId: 'o', resultRef: 'R' }],
      ['{"decision":"in_progress","operation_id":"o"}', { decision: 'in_progress', operationId: 'o' }],
      ['{"decision":"needs_reconciliation","operation_id":"o"}', { decision: 'needs_reconciliation', operationId: 'o' }],
      ['{"decision":"terminal_failure","operation_id":"o","failure_code":"fare_changed"}', { decision: 'terminal_failure', operationId: 'o', failureCode: 'fare_changed' }],
      ['{"decision":"key_reused","operation_id":"o"}', { decision: 'key_reused', operationId: 'o' }],
      ['{"decision":"subject_busy","operation_id":"o"}', { decision: 'subject_busy', operationId: 'o' }],
      ['{"decision":"refused","reason":"lease out of range"}', { decision: 'refused', reason: 'lease out of range' }],
    ];
    for (const [text, expected] of cases) {
      const { executor } = fake([text]);
      assert.deepEqual(await new PostgresOperationLedger(executor).begin(input()), expected);
    }
  });

  test('an unknown decision from the database is an error, never a start', async () => {
    const { executor } = fake(['{"decision":"started_maybe"}']);
    await assert.rejects(new PostgresOperationLedger(executor).begin(input()), LedgerDatabaseError);
  });

  test('an unknown operation type is refused before SQL is built', async () => {
    const { executor, statements } = fake([]);
    await assert.rejects(new PostgresOperationLedger(executor).begin(input({ operationType: 'refund.bogus' as never })), RangeError);
    assert.equal(statements.length, 0);
  });
});

describe('complete, renew and reconcile', () => {
  test('completion passes the result for a success and the code for a failure, never both', async () => {
    const ok = fake(['completed']);
    await new PostgresOperationLedger(ok.executor).complete('11111111-1111-1111-1111-111111111111', 'w', { outcome: 'succeeded', resultRef: 'SO-1' }, 'c');
    assert.match(ok.statements[0], /'succeeded', 'SO-1', null,/);
    const bad = fake(['completed']);
    await new PostgresOperationLedger(bad.executor).complete('11111111-1111-1111-1111-111111111111', 'w', { outcome: 'unknown', failureCode: 'timeout' }, 'c');
    assert.match(bad.statements[0], /'unknown', null, 'timeout',/);
  });

  test('a completion answer other than completed or rejected_stale is an error', async () => {
    const { executor } = fake(['maybe']);
    await assert.rejects(new PostgresOperationLedger(executor).complete('11111111-1111-1111-1111-111111111111', 'w', { outcome: 'succeeded', resultRef: 'x' }, 'c'), LedgerDatabaseError);
  });

  test('a non-UUID operation id is refused before SQL is built', async () => {
    const { executor, statements } = fake([]);
    await assert.rejects(new PostgresOperationLedger(executor).complete("x'); drop table operation_ledger; --", 'w', { outcome: 'succeeded', resultRef: 'x' }, 'c'), RangeError);
    assert.equal(statements.length, 0);
  });

  test('renewal is true only for the answer true', async () => {
    assert.equal(await new PostgresOperationLedger(fake(['true']).executor).renewLease('11111111-1111-1111-1111-111111111111', 'w', 60), true);
    assert.equal(await new PostgresOperationLedger(fake(['false']).executor).renewLease('11111111-1111-1111-1111-111111111111', 'w', 60), false);
  });

  test('reconciliation sends the evidence and the actor to the database', async () => {
    const { executor, statements } = fake(['reconciled']);
    const out = await new PostgresOperationLedger(executor).reconcile('11111111-1111-1111-1111-111111111111', { outcome: 'succeeded', resultRef: 'SO-9', evidenceRef: 'lookup-9' }, 'reconciliation:lookup-9', 'c');
    assert.equal(out, 'reconciled');
    assert.match(statements[0], /'lookup-9', 'reconciliation:lookup-9', 'c'\)::text;/);
  });
});

describe('database errors fail closed', () => {
  test('a psql that cannot connect is a LedgerDatabaseError with no SQL in its message', async () => {
    const executor = psqlExecutor({ ...process.env, PGDATABASE: 'no_such_database_for_unit_test' });
    await assert.rejects(new PostgresOperationLedger(executor).begin(input()), (error: unknown) => {
      assert.ok(error instanceof LedgerDatabaseError);
      assert.doesNotMatch((error as Error).message, /begin_operation|supplier\.order/);
      return true;
    });
  });

  test('a missing psql binary is a LedgerDatabaseError', async () => {
    const executor = psqlExecutor(process.env, '/nonexistent/psql-binary-for-test');
    await assert.rejects(executor('select 1;'), LedgerDatabaseError);
  });
});

describe('the fixture stays out of production paths', () => {
  test('the execution paths import the database ledger interface, never the in-memory fixture', () => {
    const paths = [
      '../../fulfilment/src/orchestrator.ts',
      '../../payments/src/payment-flow.ts',
      '../src/postgres-ledger.ts',
    ];
    for (const path of paths) {
      const text = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
      assert.doesNotMatch(text, /MemoryOperationLedger/, `${path} must not use the in-memory fixture`);
    }
  });
});
