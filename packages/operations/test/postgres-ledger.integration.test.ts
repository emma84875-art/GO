// Integration checks for the PostgreSQL operation ledger (Phase 19.2, docs/26). They run against a real database
// that has every migration applied. scripts/test-db.sh sets LEDGER_INTEGRATION=1 and PGDATABASE for them. Without
// those, the suite is skipped and reports why. Nothing here calls a live supplier or payment provider.
//
// Restart checks run the order worker in separate processes, so no in-memory state survives between runs.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cancelBooking, placeOrder } from '../../fulfilment/src/orchestrator.ts';
import { PostgresOperationLedger } from '../src/postgres-ledger.ts';
import { LedgerDatabaseError, psqlExecutor } from '../src/sql-executor.ts';
import { requestFingerprint, type BeginInput } from '../src/ledger.ts';
import { buildHarness, FUL, NOW } from './fixtures/order-harness.ts';
import { SupplierUnavailableError } from '../../flights/src/supplier.ts';

const enabled = process.env.LEDGER_INTEGRATION === '1' && Boolean(process.env.PGDATABASE);
const skip = enabled ? false : 'set LEDGER_INTEGRATION=1 and PGDATABASE (scripts/test-db.sh does this)';
const WORKER = fileURLToPath(new URL('./fixtures/order-worker.ts', import.meta.url));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ledger = () => new PostgresOperationLedger(psqlExecutor());

function input(over: Partial<BeginInput> = {}): BeginInput {
  return {
    operationType: 'supplier.order',
    idempotencyKey: `it-${randomUUID()}`,
    subjectRef: `booking-${randomUUID()}`,
    fingerprint: requestFingerprint({ it: true }),
    actorLabel: 'backend:integration',
    correlationId: `corr-${randomUUID()}`,
    owner: `owner-${randomUUID()}`,
    leaseSeconds: 300,
    ...over,
  };
}

// Runs one worker process and returns its result line and exit code.
function runWorker(mode: 'place' | 'capture', bookingId: string, leaseSeconds: number, crash: 'normal' | 'crash') {
  const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', WORKER, mode, bookingId, String(leaseSeconds), crash], {
    env: process.env,
    encoding: 'utf8',
  });
  const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) throw new Error(`worker printed no result (exit ${run.status}): ${run.stderr}`);
  return { exitCode: run.status, result: JSON.parse(line.slice('RESULT '.length)) as Record<string, unknown> };
}

describe('database adapter (integration)', { skip }, () => {
  test('begin, duplicate, result and repeat go through the database functions', async () => {
    const l = ledger();
    const base = input();
    const first = await l.begin(base);
    assert.equal(first.decision, 'started');
    if (first.decision !== 'started') return;
    assert.equal((await l.begin({ ...base, owner: 'other' })).decision, 'in_progress');
    assert.equal(await l.complete(first.operationId, base.owner, { outcome: 'succeeded', resultRef: 'SO-1' }, 'c'), 'completed');
    const again = await l.begin({ ...base, owner: 'third' });
    assert.deepEqual(again, { decision: 'already_succeeded', operationId: first.operationId, resultRef: 'SO-1' });
    const row = await l.byKey('supplier.order', base.idempotencyKey);
    assert.equal(row?.status, 'succeeded');
    assert.equal(row?.resultRef, 'SO-1');
    assert.deepEqual((await l.attempts(first.operationId)).map((a) => a.event), ['started', 'succeeded']);
  });

  test('values containing quotes are stored and read back exactly', async () => {
    const l = ledger();
    const key = `it-o'brien-"quoted"-${randomUUID()}`;
    const started = await l.begin(input({ idempotencyKey: key, correlationId: "corr-'x'" }));
    assert.equal(started.decision, 'started');
    const row = await l.byKey('supplier.order', key);
    assert.equal(row?.idempotencyKey, key);
    assert.equal(row?.correlationId, "corr-'x'");
  });

  test('lease expiry is decided by the database clock: an expired external lease becomes unknown', async () => {
    const l = ledger();
    const base = input({ leaseSeconds: 1 });
    const first = await l.begin(base);
    assert.equal(first.decision, 'started');
    await sleep(1200);
    assert.equal((await l.begin({ ...base, owner: 'after-expiry' })).decision, 'needs_reconciliation');
    assert.equal((await l.byKey('supplier.order', base.idempotencyKey))?.status, 'unknown');
  });

  test('renewal keeps the lease for the holder; a non-holder cannot renew or take over', async () => {
    const l = ledger();
    const base = input({ leaseSeconds: 1 });
    const first = await l.begin(base);
    if (first.decision !== 'started') throw new Error('expected start');
    assert.equal(await l.renewLease(first.operationId, base.owner, 300), true);
    assert.equal(await l.renewLease(first.operationId, 'intruder', 300), false);
    await sleep(1200);
    assert.equal((await l.begin({ ...base, owner: 'late' })).decision, 'in_progress');
  });

  test('a stale completion is rejected by the database and recorded', async () => {
    const l = ledger();
    const base = input();
    const first = await l.begin(base);
    if (first.decision !== 'started') throw new Error('expected start');
    assert.equal(await l.complete(first.operationId, 'intruder', { outcome: 'succeeded', resultRef: 'SO-X' }, 'c'), 'rejected_stale');
    assert.equal((await l.byKey('supplier.order', base.idempotencyKey))?.status, 'in_progress');
    assert.ok((await l.attempts(first.operationId)).some((a) => a.event === 'stale_completion_rejected'));
  });

  test('an out-of-range lease is refused by the database function', async () => {
    assert.equal((await ledger().begin(input({ leaseSeconds: 0 }))).decision, 'refused');
  });

  test('fail closed: when the database cannot be reached, no supplier order is sent', async () => {
    const broken = new PostgresOperationLedger(psqlExecutor({ ...process.env, PGDATABASE: 'no_such_database_for_ledger_test' }));
    const bookingId = randomUUID();
    const harness = await buildHarness({ bookingId, ledger: broken });
    let created = 0;
    const createOrder = harness.supplier.createOrder!.bind(harness.supplier);
    harness.supplier.createOrder = async (...args: Parameters<typeof createOrder>) => {
      created += 1;
      return createOrder(...args);
    };
    await assert.rejects(placeOrder(harness.deps, FUL, bookingId, NOW), LedgerDatabaseError);
    assert.equal(created, 0);
  });
});

describe('concurrency through the database (integration)', { skip }, () => {
  test('eight concurrent placeOrder calls send one supplier order and every caller sees one booking state', async () => {
    const bookingId = randomUUID();
    const harnesses = await Promise.all(Array.from({ length: 8 }, () => buildHarness({ bookingId, ledger: ledger() })));
    let externalCalls = 0;
    for (const h of harnesses) {
      const createOrder = h.supplier.createOrder!.bind(h.supplier);
      h.supplier.createOrder = async (...args: Parameters<typeof createOrder>) => {
        externalCalls += 1;
        return createOrder(...args);
      };
    }
    const outcomes = await Promise.all(harnesses.map((h) => placeOrder(h.deps, FUL, bookingId, NOW)));
    assert.equal(externalCalls, 1);
    // Late callers read the recorded result; early callers saw the live lease and returned without an order.
    const orderIds = new Set(outcomes.map((rec) => rec.orderId).filter((id) => id !== null));
    assert.equal(orderIds.size, 1, 'every caller that reports an order reports the same one');
  });
});

describe('restarts (integration, separate processes)', { skip }, () => {
  test('a crash after the order was sent is not repeated after restart; the operation becomes unknown after its lease expires', async () => {
    const bookingId = randomUUID();
    const crashed = runWorker('place', bookingId, 1, 'crash');
    assert.equal(crashed.exitCode, 3);
    assert.equal(crashed.result.externalCalls, 1);

    const key = `booking:${bookingId}:supplier_order:1`;
    assert.equal((await ledger().byKey('supplier.order', key))?.status, 'in_progress');

    // Restart while the lease is still live: the new process must not send anything.
    const early = runWorker('place', bookingId, 1, 'normal');
    assert.equal(early.result.externalCalls, 0);
    assert.equal((await ledger().byKey('supplier.order', key))?.status, 'in_progress');

    await sleep(1200);
    const afterExpiry = runWorker('place', bookingId, 1, 'normal');
    assert.equal(afterExpiry.result.status, 'order_unknown');
    assert.equal(afterExpiry.result.externalCalls, 0);
    const row = await ledger().byKey('supplier.order', key);
    assert.equal(row?.status, 'unknown');
    const again = runWorker('place', bookingId, 1, 'normal');
    assert.equal(again.result.externalCalls, 0, 'a third restart still sends nothing');
    const events = (await ledger().attempts(row!.id)).map((a) => a.event);
    assert.ok(events.includes('lease_expired_unknown'));
  });

  test('a retry after a successful order, in a new process, returns the existing order and sends nothing', async () => {
    const bookingId = randomUUID();
    const first = runWorker('place', bookingId, 300, 'normal');
    assert.equal(first.result.externalCalls, 1);
    assert.equal(first.result.status, 'tickets_issued', 'the fixture issues tickets as soon as it is paid');
    const orderId = first.result.orderId as string;
    assert.ok(orderId);

    const retry = runWorker('place', bookingId, 300, 'normal');
    assert.equal(retry.result.externalCalls, 0);
    assert.equal(retry.result.orderId, orderId);
    const row = await ledger().byKey('supplier.order', `booking:${bookingId}:supplier_order:1`);
    assert.equal(row?.status, 'succeeded');
    assert.equal(row?.resultRef, orderId);
  });

  test('a capture sent before a crash is not sent again after restart; the booking waits for a person', async () => {
    const bookingId = randomUUID();
    const crashed = runWorker('capture', bookingId, 1, 'crash');
    assert.equal(crashed.exitCode, 3);
    assert.equal(crashed.result.externalCalls, 1);

    await sleep(1200);
    const after = runWorker('capture', bookingId, 1, 'normal');
    assert.equal(after.result.externalCalls, 0, 'the provider capture is not sent again');
    assert.match(String(after.result.blockedReason), /needs_reconciliation/);
    // The capture key is the intent reference plus ':capture:1' (payment-flow.ts). The intent reference is derived from the booking.
    const row = await ledger().byKey('payment.capture_request', `booking:${bookingId}:payment_authorise:1:capture:1`);
    assert.equal(row?.status, 'unknown');
  });
});

describe('cancellation through the database (integration)', { skip }, () => {
  test('a lost cancellation reply is unknown in the database, and the cancel is not sent again', async () => {
    const bookingId = randomUUID();
    const l = ledger();
    const harness = await buildHarness({ bookingId, ledger: l });
    const placed = await placeOrder(harness.deps, FUL, bookingId, NOW);
    assert.ok(placed.orderId, 'the order was placed');

    let cancelCalls = 0;
    harness.supplier.cancelOrder = async () => {
      cancelCalls += 1;
      throw new SupplierUnavailableError('timeout', 'Reply lost');
    };
    const pending = await cancelBooking(harness.deps, FUL, bookingId, NOW);
    assert.equal(pending.status, 'cancellation_pending');
    assert.equal(cancelCalls, 1);
    const key = `booking:${bookingId}:supplier_cancel:1`;
    assert.equal((await l.byKey('supplier.cancel', key))?.status, 'unknown');

    // The same request as the orchestrator's cancel, so the ledger sees a retry rather than a key reuse.
    const sameRequest = requestFingerprint({ bookingId, orderId: placed.orderId });
    const retry = await l.begin(input({ operationType: 'supplier.cancel', idempotencyKey: key, subjectRef: bookingId, fingerprint: sameRequest }));
    assert.equal(retry.decision, 'needs_reconciliation');
    assert.equal(cancelCalls, 1);
  });
});
