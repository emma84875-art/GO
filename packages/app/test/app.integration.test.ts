// Integration checks for the payment path on the PostgreSQL authority (Phase 19.2, docs/26). They run against a real
// database with every migration applied. scripts/test-db.sh sets LEDGER_INTEGRATION=1 and PGDATABASE. Without them the
// suite is skipped. Every restart is a separate process, so a later run sees only what the database and the provider
// hold. The provider double keeps its record in a file, and the tests check that record, not the application's view.
// Nothing here calls a live provider.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LedgerDatabaseError, psqlExecutor } from '../../operations/src/sql-executor.ts';
import { startApplication } from '../src/application.ts';
import { FileBackedFixturePaymentProvider } from './fixtures/file-provider.ts';
import { createQuotedBooking, fixtureProviderRef, signedWebhook, SECRET } from './fixtures/app-fixture.ts';
import { paymentStartReference } from '../../payments/src/durable-flow.ts';
import { FixturePaymentProvider } from '../../payments/src/adapters/fixture.ts';

const enabled = process.env.LEDGER_INTEGRATION === '1' && Boolean(process.env.PGDATABASE);
const skip = enabled ? false : 'set LEDGER_INTEGRATION=1 and PGDATABASE (scripts/test-db.sh does this)';
const WORKER = fileURLToPath(new URL('./fixtures/app-worker.ts', import.meta.url));

interface WorkerRun {
  readonly exitCode: number | null;
  readonly result: Record<string, any>;
}

function runWorker(args: string[], providerFile: string): Promise<WorkerRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', WORKER, ...args],
      { env: { ...process.env, APP_TEST_PROVIDER_FILE: providerFile }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
      if (!line) {
        reject(new Error(`worker printed no result (exit ${exitCode}): ${stderr}`));
        return;
      }
      resolve({ exitCode, result: JSON.parse(line.slice('RESULT '.length)) });
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One fresh booking and one provider record per test, so tests cannot see each other's state.
async function scenario() {
  const { bookingId, ownerId } = await createQuotedBooking(psqlExecutor());
  const dir = mkdtempSync(join(tmpdir(), 'go-payment-'));
  const providerFile = join(dir, 'provider.json');
  const provider = new FileBackedFixturePaymentProvider(providerFile, SECRET);
  const reference = paymentStartReference(bookingId);
  const start = (scenarioName = 'normal', lease = 300) => runWorker(['start', bookingId, ownerId, String(lease), scenarioName], providerFile);
  return { bookingId, ownerId, providerFile, provider, reference, start, read: () => runWorker(['read', bookingId], providerFile) };
}

describe('payment start on the database authority (integration)', { skip }, () => {
  test('starts, connects, and fails closed when the database cannot be reached', async () => {
    const unreachable = psqlExecutor({ ...process.env, PGDATABASE: 'no_such_database_for_go_tests' });
    await assert.rejects(startApplication({ sql: unreachable, provider: new FixturePaymentProvider(SECRET) }), LedgerDatabaseError);
  });

  test('a start is written before the provider is called, then records the provider reference', async () => {
    const s = await scenario();
    const started = await s.start();
    assert.equal(started.exitCode, 0);
    assert.equal(started.result.outcome.status, 'started');
    assert.equal(started.result.outcome.reused, false);
    assert.equal(started.result.initiateCalls, 1);

    const row = (await s.read()).result.payment;
    assert.equal(row.status, 'initiated');
    assert.equal(row.providerReference, started.result.outcome.providerReference, 'the provider reference is recorded');
    assert.equal(row.reference, s.reference);
    assert.equal(s.provider.initiateCount(s.reference), 1);
  });

  test('a restarted process reuses the recorded payment and initiates nothing', async () => {
    const s = await scenario();
    const first = await s.start();
    const again = await s.start();
    assert.equal(again.result.outcome.status, 'started');
    assert.equal(again.result.outcome.reused, true);
    assert.equal(again.result.outcome.paymentId, first.result.outcome.paymentId);
    assert.equal(again.result.initiateCalls, 0);
    assert.equal(s.provider.initiateCount(s.reference), 1, 'the provider\'s own record shows one initiation');
  });

  test('a crash after the provider accepts is reconciled from provider evidence, never initiated twice', async () => {
    const s = await scenario();
    const crashed = await s.start('crash-after-provider', 1);
    assert.equal(crashed.exitCode, 3, 'the process exits after the provider accepted');
    assert.equal(s.provider.initiateCount(s.reference), 1);
    assert.match((await s.read()).result.payment.providerReference, /^pending:/, 'the reference was not recorded');

    await sleep(1500); // let the one-second lease expire
    const restarted = await s.start('normal', 1);
    assert.equal(restarted.result.outcome.status, 'reconciliation_required');
    assert.equal(restarted.result.initiateCalls, 0, 'an unknown start is never initiated again automatically');

    const reconciled = await runWorker(['reconcile', s.bookingId], s.providerFile);
    assert.equal(reconciled.result.outcome.status, 'started');
    assert.equal(reconciled.result.outcome.providerReference, fixtureProviderRef(s.reference));
    assert.equal((await s.read()).result.payment.providerReference, fixtureProviderRef(s.reference));

    const after = await s.start();
    assert.equal(after.result.outcome.status, 'started');
    assert.equal(after.result.outcome.reused, true);
    assert.equal(after.result.initiateCalls, 0);
    assert.equal(s.provider.initiateCount(s.reference), 1);
  });

  test('a lost reply is unknown, not failed, and is not initiated again until reconciled', async () => {
    const s = await scenario();
    const lost = await s.start('lost-reply');
    assert.equal(lost.result.outcome.status, 'reconciliation_required');
    assert.equal(lost.result.initiateCalls, 1);
    assert.equal(s.provider.initiateCount(s.reference), 1, 'the provider did record the payment');

    const again = await s.start();
    assert.equal(again.result.outcome.status, 'reconciliation_required');
    assert.equal(again.result.initiateCalls, 0);
    assert.equal(s.provider.initiateCount(s.reference), 1);

    const reconciled = await runWorker(['reconcile', s.bookingId], s.providerFile);
    assert.equal(reconciled.result.outcome.status, 'started');
    assert.equal(s.provider.initiateCount(s.reference), 1);
  });

  test('a provider with no payment for the reference allows one new attempt, and only after that evidence', async () => {
    const s = await scenario();
    const refused = await s.start('refuse-before-record');
    assert.equal(refused.result.outcome.status, 'reconciliation_required');
    assert.equal(s.provider.initiateCount(s.reference), 0, 'nothing was recorded by the provider');

    const blocked = await s.start();
    assert.equal(blocked.result.outcome.status, 'reconciliation_required', 'no retry before reconciliation');
    assert.equal(blocked.result.initiateCalls, 0);

    const evidence = await runWorker(['reconcile', s.bookingId], s.providerFile);
    assert.equal(evidence.result.outcome.status, 'retry_allowed');

    const attempt = await s.start();
    assert.equal(attempt.result.outcome.status, 'started');
    assert.equal(attempt.result.initiateCalls, 1);
    assert.equal(s.provider.initiateCount(s.reference), 1);
  });

  test('a crash after the reference is recorded is recovered without a second initiation', async () => {
    const s = await scenario();
    const crashed = await s.start('record-crash');
    assert.equal(crashed.exitCode, 3);
    const after = await s.start();
    assert.equal(after.result.outcome.status, 'started');
    assert.equal(after.result.outcome.reused, true);
    assert.equal(after.result.initiateCalls, 0);
    assert.equal(s.provider.initiateCount(s.reference), 1);
  });

  test('a verified authorisation is applied once, and a replay after restart is a duplicate', async () => {
    const s = await scenario();
    const started = await s.start();
    const providerRef = started.result.outcome.providerReference as string;

    const event = signedWebhook(s.provider, { id: `evt-auth-${s.bookingId}`, event: 'authorised', providerRef, state: 'authorised' });
    const applied = await runWorker(['webhook', event.raw, event.signature], s.providerFile);
    assert.equal(applied.result.outcome.status, 'applied');
    assert.equal((await s.read()).result.payment.status, 'authorised');

    const replay = await runWorker(['webhook', event.raw, event.signature], s.providerFile);
    assert.equal(replay.result.outcome.status, 'duplicate');
    assert.equal((await s.read()).result.payment.status, 'authorised', 'a replay changes nothing');
  });

  test('a webhook with a bad signature is rejected and changes nothing', async () => {
    const s = await scenario();
    const started = await s.start();
    const providerRef = started.result.outcome.providerReference as string;
    const event = signedWebhook(s.provider, { id: `evt-forged-${s.bookingId}`, event: 'authorised', providerRef, state: 'authorised' });
    const forged = await runWorker(['webhook', event.raw, 'not-the-signature'], s.providerFile);
    assert.equal(forged.result.outcome.status, 'rejected');
    assert.equal(forged.result.outcome.reason, 'bad_signature');
    assert.equal((await s.read()).result.payment.status, 'initiated');
  });

  test('two processes racing to start one payment initiate it once', async () => {
    const s = await scenario();
    const [a, b] = await Promise.all([s.start(), s.start()]);
    assert.equal(a.exitCode, 0);
    assert.equal(b.exitCode, 0);
    assert.equal(a.result.initiateCalls + b.result.initiateCalls, 1, 'exactly one process may initiate');
    assert.equal(s.provider.initiateCount(s.reference), 1);
    const row = (await s.read()).result.payment;
    assert.match(row.providerReference, /^fx_/, 'one provider reference, recorded');
  });
});
