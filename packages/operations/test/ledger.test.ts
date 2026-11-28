// Rules of the operation ledger, checked against the in-memory fixture. The same rules are checked against the
// database functions in supabase/tests/operation_ledger.sql and against real processes in
// packages/operations/test/postgres-ledger.integration.test.ts.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryOperationLedger, requestFingerprint, type BeginInput, type OperationType } from '../src/ledger.ts';

const T0 = '2026-11-28T10:00:00.000Z';
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const BOOKING = '00000000-0000-0000-0000-00000000b001';
const ORDER_KEY = `booking:${BOOKING}:supplier_order:1`;

// Each test gets its own ledger and a clock the test controls.
function harness() {
  const clock = { now: T0 };
  const ledger = new MemoryOperationLedger(() => clock.now);
  return { ledger, clock, setTime: (seconds: number) => { clock.now = at(seconds); } };
}

function input(over: Partial<BeginInput> = {}): BeginInput {
  return {
    operationType: 'supplier.order',
    idempotencyKey: ORDER_KEY,
    subjectRef: BOOKING,
    fingerprint: requestFingerprint({ offer: 'o1', passengers: 2 }),
    actorLabel: 'backend:fulfilment.place_order',
    correlationId: 'corr-1',
    owner: 'worker-a',
    leaseSeconds: 60,
    ...over,
  };
}

const OK = { outcome: 'succeeded', resultRef: 'supplier-order-77' } as const;

describe('one key, one operation', () => {
  test('a new key starts exactly one operation at attempt 1 and records the start', async () => {
    const { ledger } = harness();
    const d = await ledger.begin(input());
    assert.equal(d.decision, 'started');
    const row = await ledger.byKey('supplier.order', ORDER_KEY);
    assert.equal(row?.status, 'in_progress');
    assert.equal(row?.attemptCount, 1);
    assert.deepEqual((await ledger.attempts(row!.id)).map((a) => a.event), ['started']);
  });

  test('a duplicate request while the first is in progress creates nothing new', async () => {
    const { ledger } = harness();
    const first = await ledger.begin(input());
    const second = await ledger.begin(input({ owner: 'worker-b' }));
    assert.equal(second.decision, 'in_progress');
    assert.equal(second.operationId, first.decision === 'started' ? first.operationId : '');
    assert.equal((await ledger.attempts(first.operationId)).length, 1);
  });

  test('a repeat after success returns the recorded result and never calls the supplier again', async () => {
    const { ledger, setTime } = harness();
    const d = await ledger.begin(input());
    if (d.decision !== 'started') throw new Error('expected start');
    assert.equal(await ledger.complete(d.operationId, 'worker-a', OK, 'corr-1'), 'completed');
    setTime(5);
    assert.deepEqual(await ledger.begin(input({ owner: 'worker-b' })), { decision: 'already_succeeded', operationId: d.operationId, resultRef: 'supplier-order-77' });
  });

  test('the same key with a different request is refused as a key reuse and changes nothing', async () => {
    const { ledger } = harness();
    await ledger.begin(input());
    const other = await ledger.begin(input({ fingerprint: requestFingerprint({ offer: 'o2', passengers: 2 }) }));
    assert.equal(other.decision, 'key_reused');
    assert.equal((await ledger.byKey('supplier.order', ORDER_KEY))?.attemptCount, 1);
  });

  test('a second key for the same booking supplier order is refused while the first is live', async () => {
    const { ledger } = harness();
    await ledger.begin(input());
    assert.equal((await ledger.begin(input({ idempotencyKey: 'another-key' }))).decision, 'subject_busy');
  });

  test('booking.create is keyed only by its key, so two bookings with different keys can exist', async () => {
    const { ledger } = harness();
    const a = await ledger.begin(input({ operationType: 'booking.create', idempotencyKey: 'cart-1', subjectRef: 'cart-1' }));
    const b = await ledger.begin(input({ operationType: 'booking.create', idempotencyKey: 'cart-2', subjectRef: 'cart-1' }));
    assert.equal(a.decision, 'started');
    assert.equal(b.decision, 'started');
  });
});

describe('concurrent execution', () => {
  test('two callers at the same moment: exactly one starts, the other sees the live lease', async () => {
    const { ledger } = harness();
    const results = (await Promise.all([ledger.begin(input({ owner: 'a' })), ledger.begin(input({ owner: 'b' }))])).map((d) => d.decision);
    assert.deepEqual(results.sort(), ['in_progress', 'started']);
  });

  test('a slow external call holds the operation: workers that arrive during it do not call the supplier', async () => {
    const { ledger } = harness();
    let supplierCalls = 0;
    const attempt = async (owner: string) => {
      const d = await ledger.begin(input({ owner }));
      if (d.decision !== 'started') return d.decision;
      supplierCalls += 1;
      await new Promise((r) => setTimeout(r, 5));
      await ledger.complete(d.operationId, owner, OK, 'corr');
      return 'done';
    };
    const outcomes = await Promise.all([attempt('a'), attempt('b'), attempt('c')]);
    assert.equal(supplierCalls, 1);
    assert.equal(outcomes.filter((o) => o === 'done').length, 1);
    assert.equal(outcomes.filter((o) => o === 'in_progress').length, 2);
  });
});

describe('retries', () => {
  test('a retryable failure can be retried under the same key, at the next attempt', async () => {
    const { ledger } = harness();
    const d = await ledger.begin(input());
    if (d.decision !== 'started') throw new Error('expected start');
    await ledger.complete(d.operationId, 'worker-a', { outcome: 'failed_retryable', failureCode: 'supplier_unavailable' }, 'corr');
    const retry = await ledger.begin(input({ owner: 'worker-b' }));
    assert.deepEqual(retry.decision === 'started' && { attempt: retry.attemptNo, takeover: retry.takeover }, { attempt: 2, takeover: false });
    assert.equal((await ledger.get(d.operationId))?.status, 'in_progress');
  });

  test('a terminal failure is never run again under the same key', async () => {
    const { ledger } = harness();
    const d = await ledger.begin(input());
    if (d.decision !== 'started') throw new Error('expected start');
    await ledger.complete(d.operationId, 'worker-a', { outcome: 'failed_terminal', failureCode: 'fare_changed' }, 'corr');
    assert.deepEqual(await ledger.begin(input()), { decision: 'terminal_failure', operationId: d.operationId, failureCode: 'fare_changed' });
  });

  test('a terminal failure on one key does not block a new key for the same booking', async () => {
    const { ledger } = harness();
    const d = await ledger.begin(input());
    if (d.decision !== 'started') throw new Error('expected start');
    await ledger.complete(d.operationId, 'worker-a', { outcome: 'failed_terminal', failureCode: 'no_seats' }, 'corr');
    assert.equal((await ledger.begin(input({ idempotencyKey: 'new-key' }))).decision, 'started');
  });
});

describe('interrupted operations and recovery', () => {
  test('an interrupted external operation (lease expired) becomes unknown, is never retried, and needs reconciliation', async () => {
    const { ledger, setTime } = harness();
    const d = await ledger.begin(input({ leaseSeconds: 10 }));
    if (d.decision !== 'started') throw new Error('expected start');
    setTime(30);
    assert.equal((await ledger.begin(input({ owner: 'worker-b' }))).decision, 'needs_reconciliation');
    assert.equal((await ledger.get(d.operationId))?.status, 'unknown');
    assert.equal((await ledger.get(d.operationId))?.failureCode, 'lease_expired');
    setTime(60);
    assert.equal((await ledger.begin(input({ owner: 'worker-c' }))).decision, 'needs_reconciliation');
    assert.ok((await ledger.attempts(d.operationId)).some((a) => a.event === 'lease_expired_unknown'));
  });

  test('the interrupted worker, if it wakes up, cannot record a result for an unknown operation', async () => {
    const { ledger, setTime } = harness();
    const d = await ledger.begin(input({ leaseSeconds: 10 }));
    if (d.decision !== 'started') throw new Error('expected start');
    setTime(30);
    await ledger.begin(input({ owner: 'worker-b' }));
    assert.equal(await ledger.complete(d.operationId, 'worker-a', OK, 'corr'), 'rejected_stale');
    assert.equal((await ledger.get(d.operationId))?.status, 'unknown');
  });

  test('reconciliation with evidence resolves an unknown operation, and a repeat then returns the result', async () => {
    const { ledger, setTime } = harness();
    const d = await ledger.begin(input({ leaseSeconds: 10 }));
    if (d.decision !== 'started') throw new Error('expected start');
    setTime(30);
    await ledger.begin(input({ owner: 'worker-b' }));
    setTime(40);
    assert.equal(await ledger.reconcile(d.operationId, { outcome: 'succeeded', resultRef: 'supplier-order-77', evidenceRef: 'supplier-lookup-123' }, 'reconciliation:lookup-123', 'corr'), 'reconciled');
    setTime(41);
    assert.equal((await ledger.begin(input({ owner: 'worker-c' }))).decision, 'already_succeeded');
  });

  test('reconciliation confirmed as not created allows a single retry', async () => {
    const { ledger, setTime } = harness();
    const d = await ledger.begin(input({ leaseSeconds: 10 }));
    if (d.decision !== 'started') throw new Error('expected start');
    setTime(30);
    await ledger.begin(input({ owner: 'worker-b' }));
    await ledger.reconcile(d.operationId, { outcome: 'failed_retryable', failureCode: 'not_created', evidenceRef: 'supplier-lookup-124' }, 'reconciliation:lookup-124', 'corr');
    setTime(41);
    assert.equal((await ledger.begin(input({ owner: 'worker-c' }))).decision, 'started');
  });

  test('reconciliation is refused without evidence, without a reconciliation actor, or for an operation that is not unknown', async () => {
    const { ledger, setTime } = harness();
    const d = await ledger.begin(input({ leaseSeconds: 10 }));
    if (d.decision !== 'started') throw new Error('expected start');
    assert.equal(await ledger.reconcile(d.operationId, { outcome: 'succeeded', resultRef: 'x', evidenceRef: 'e' }, 'reconciliation:l', 'c'), 'refused', 'still in progress');
    setTime(30);
    await ledger.begin(input({ owner: 'worker-b' }));
    assert.equal(await ledger.reconcile(d.operationId, { outcome: 'succeeded', resultRef: 'x', evidenceRef: '' }, 'reconciliation:l', 'c'), 'refused', 'no evidence');
    assert.equal(await ledger.reconcile(d.operationId, { outcome: 'succeeded', resultRef: 'x', evidenceRef: 'e' }, 'backend:worker', 'c'), 'refused', 'not a reconciliation actor');
  });

  test('an internal operation (booking.create) interrupted mid-way is taken over, and the old holder is fenced out', async () => {
    const { ledger, setTime } = harness();
    const bc = { operationType: 'booking.create' as OperationType, idempotencyKey: 'cart-9', subjectRef: 'cart-9' };
    const d = await ledger.begin(input({ ...bc, leaseSeconds: 10 }));
    if (d.decision !== 'started') throw new Error('expected start');
    setTime(30);
    const takeover = await ledger.begin(input({ ...bc, owner: 'worker-b' }));
    assert.deepEqual(takeover.decision === 'started' && { attempt: takeover.attemptNo, takeover: takeover.takeover }, { attempt: 2, takeover: true });
    assert.equal(await ledger.complete(d.operationId, 'worker-a', OK, 'corr'), 'rejected_stale');
    assert.equal(await ledger.complete(d.operationId, 'worker-b', OK, 'corr'), 'completed');
  });
});

describe('leases and fencing', () => {
  test('a renewed lease keeps the holder the only worker, past the original expiry', async () => {
    const { ledger, setTime } = harness();
    const d = await ledger.begin(input({ leaseSeconds: 10 }));
    if (d.decision !== 'started') throw new Error('expected start');
    setTime(8);
    assert.equal(await ledger.renewLease(d.operationId, 'worker-a', 60), true);
    setTime(30);
    assert.equal((await ledger.begin(input({ owner: 'worker-b' }))).decision, 'in_progress');
  });

  test('only the current lease holder can renew', async () => {
    const { ledger } = harness();
    const d = await ledger.begin(input({ leaseSeconds: 10 }));
    if (d.decision !== 'started') throw new Error('expected start');
    assert.equal(await ledger.renewLease(d.operationId, 'worker-b', 60), false);
  });

  test('a stale completion is recorded as rejected and changes nothing', async () => {
    const { ledger } = harness();
    const d = await ledger.begin(input({ operationType: 'payment.capture_request', idempotencyKey: 'capture:p1', subjectRef: 'p1', leaseSeconds: 10 }));
    if (d.decision !== 'started') throw new Error('expected start');
    assert.equal(await ledger.complete(d.operationId, 'someone-else', OK, 'corr'), 'rejected_stale');
    assert.equal((await ledger.get(d.operationId))?.status, 'in_progress');
    assert.ok((await ledger.attempts(d.operationId)).some((a) => a.event === 'stale_completion_rejected'));
  });
});

describe('validation and audit', () => {
  test('a lease outside the allowed range is refused', async () => {
    const { ledger } = harness();
    assert.equal((await ledger.begin(input({ leaseSeconds: 0 }))).decision, 'refused');
    assert.equal((await ledger.begin(input({ leaseSeconds: 4000 }))).decision, 'refused');
  });

  test('a succeeded completion needs a result reference, and a failure needs a code', async () => {
    const { ledger } = harness();
    const d = await ledger.begin(input());
    if (d.decision !== 'started') throw new Error('expected start');
    await assert.rejects(ledger.complete(d.operationId, 'worker-a', { outcome: 'succeeded', resultRef: ' ' }, 'c'), RangeError);
    await assert.rejects(ledger.complete(d.operationId, 'worker-a', { outcome: 'failed_retryable', failureCode: '' }, 'c'), RangeError);
  });

  test('every attempt carries the correlation reference of its call', async () => {
    const { ledger } = harness();
    const d = await ledger.begin(input({ correlationId: 'req-42' }));
    if (d.decision !== 'started') throw new Error('expected start');
    await ledger.complete(d.operationId, 'worker-a', OK, 'req-42');
    const row = (await ledger.get(d.operationId))!;
    assert.equal(row.correlationId, 'req-42');
    assert.equal(row.actorLabel, 'backend:fulfilment.place_order');
    assert.ok((await ledger.attempts(d.operationId)).every((a) => a.correlationId === 'req-42'));
  });

  test('request fingerprints are stable for the same request and differ for a different one', () => {
    assert.equal(requestFingerprint({ a: 1, b: 2 }), requestFingerprint({ a: 1, b: 2 }));
    assert.notEqual(requestFingerprint({ a: 1 }), requestFingerprint({ a: 2 }));
  });
});
