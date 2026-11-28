// A separate process that starts the application against PostgreSQL, does one thing, and exits. Restart tests run it
// several times, so no memory survives between runs: each run sees only what the database and the provider file hold.
//
//   start     <bookingId> <ownerUserId> <leaseSeconds> <normal|crash-after-provider|lost-reply|refuse-before-record|record-crash>
//   reconcile <bookingId>
//   webhook   <rawBody> <signature>
//   read      <bookingId>
//
// The provider double's state is in the file named by APP_TEST_PROVIDER_FILE. Every result is printed as one RESULT line.
import { writeSync } from 'node:fs';
import { paymentStartReference } from '../../../payments/src/durable-flow.ts';
import { psqlExecutor } from '../../../operations/src/sql-executor.ts';
import { startApplication } from '../../src/application.ts';
import { FileBackedFixturePaymentProvider } from './file-provider.ts';
import { FIXTURE_WEBHOOK_HEADER, PAY, SECRET, AMOUNT_MINOR, CURRENCY, HOLD_EXPIRY, NOW } from './app-fixture.ts';
const [mode, ...args] = process.argv.slice(2);
const counts = { initiateCalls: 0 };

function finish(result: Record<string, unknown>, exitCode: number): never {
  // writeSync, not process.stdout.write: the line must be written before process.exit.
  writeSync(1, `RESULT ${JSON.stringify({ ...result, ...counts, crashed: exitCode !== 0 })}\n`);
  process.exit(exitCode);
}

const providerFile = process.env.APP_TEST_PROVIDER_FILE;
if (!providerFile) throw new Error('APP_TEST_PROVIDER_FILE must name the provider state file');
const provider = new FileBackedFixturePaymentProvider(providerFile, SECRET);

if (mode === 'start') {
  const [bookingId, ownerUserId, leaseArg, scenarioArg] = args as [string, string, string, string | undefined];
  const scenario = scenarioArg ?? 'normal';
  const app = await startApplication({ sql: psqlExecutor(), provider, paymentStartLeaseSeconds: Number(leaseArg) });
  const initiate = provider.initiate.bind(provider);
  provider.initiate = async (request) => {
    counts.initiateCalls += 1;
    if (scenario === 'refuse-before-record') throw new Error('connection refused before the provider recorded anything');
    const result = await initiate(request);
    if (scenario === 'crash-after-provider') finish({ mode, scenario }, 3);
    if (scenario === 'lost-reply') throw new Error('the reply was lost after the provider recorded the payment');
    return result;
  };
  if (scenario === 'record-crash') {
    const complete = app.ledger.complete.bind(app.ledger);
    app.ledger.complete = async (...completeArgs: Parameters<typeof complete>) => {
      const outcome = await complete(...completeArgs);
      finish({ mode, scenario, recorded: outcome }, 3);
    };
  }
  const outcome = await app.startPayment(PAY, {
    bookingId,
    ownerUserId,
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    customerEmail: 'ada@example.com',
    holdExpiresAtUtc: HOLD_EXPIRY,
  }, NOW);
  finish({ mode, outcome }, 0);
}

if (mode === 'reconcile') {
  const app = await startApplication({ sql: psqlExecutor(), provider });
  const bookingId = args[0]!;
  const outcome = await app.reconcilePaymentStart(bookingId, 'reconciliation:integration-test');
  finish({ mode, outcome }, 0);
}

if (mode === 'webhook') {
  const app = await startApplication({ sql: psqlExecutor(), provider });
  const [raw, signature] = args as [string, string];
  const outcome = await app.handleWebhook(raw, { [FIXTURE_WEBHOOK_HEADER]: signature }, NOW);
  finish({ mode, outcome }, 0);
}

if (mode === 'read') {
  const app = await startApplication({ sql: psqlExecutor(), provider });
  const bookingId = args[0]!;
  const row = await app.authority.findByReference(paymentStartReference(bookingId));
  finish({ mode, payment: row }, 0);
}

throw new Error(`unknown mode ${mode}`);
