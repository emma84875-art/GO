// A separate process that performs one external operation against the PostgreSQL ledger, then exits. Restart tests run
// it several times, so each run is a real restart: no memory survives between runs.
//
//   node --experimental-strip-types order-worker.ts <place|capture> <bookingId> <leaseSeconds> <normal|crash>
//
// "crash" ends the process right after the external call is counted and before its result is recorded, which is the
// case that must not cause a second call when the operation is retried later. The result is printed as one RESULT line.

import { writeSync } from 'node:fs';
import { placeOrder, captureIfVerified } from '../../../fulfilment/src/orchestrator.ts';
import { PostgresOperationLedger } from '../../src/postgres-ledger.ts';
import { psqlExecutor } from '../../src/sql-executor.ts';
import { buildHarness, FUL, NOW } from './order-harness.ts';

const [mode, bookingId, leaseArg, crashArg] = process.argv.slice(2);
if (!mode || !bookingId || !leaseArg || !crashArg) {
  throw new Error('usage: order-worker <place|capture> <bookingId> <leaseSeconds> <normal|crash>');
}
const crash = crashArg === 'crash';
const counts = { externalCalls: 0 };

function finish(result: Record<string, unknown>, exitCode: number): never {
  // writeSync, not process.stdout.write: the line must be written before process.exit.
  writeSync(1, `RESULT ${JSON.stringify({ ...result, externalCalls: counts.externalCalls, crashed: exitCode !== 0 })}\n`);
  process.exit(exitCode);
}

const ledger = new PostgresOperationLedger(psqlExecutor());

if (mode === 'place') {
  const harness = await buildHarness({ bookingId, ledger, externalLeaseSeconds: Number(leaseArg) });
  const createOrder = harness.supplier.createOrder!.bind(harness.supplier);
  harness.supplier.createOrder = async (...args: Parameters<typeof createOrder>) => {
    counts.externalCalls += 1;
    if (crash) finish({ mode }, 3);
    return createOrder(...args);
  };
  const rec = await placeOrder(harness.deps, FUL, bookingId, NOW);
  finish({ mode, status: rec.status, orderId: rec.orderId, lockedReason: rec.lockedReason }, 0);
}

if (mode === 'capture') {
  const harness = await buildHarness({ bookingId, ledger, status: 'verified', externalLeaseSeconds: Number(leaseArg) });
  const capture = harness.payments.capture!.bind(harness.payments);
  harness.payments.capture = async (...args: Parameters<typeof capture>) => {
    counts.externalCalls += 1;
    if (crash) finish({ mode }, 3);
    return capture(...args);
  };
  const rec = await captureIfVerified(harness.deps, FUL, bookingId, NOW);
  finish({ mode, status: rec.status, blockedReason: rec.blockedReason }, 0);
}

throw new Error(`unknown mode ${mode}`);
