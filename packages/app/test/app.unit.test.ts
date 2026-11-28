// Unit checks for the composition root's start-up: it must refuse to run against a database without the payment
// functions, and must run when they are present. The SQL executor is a fake.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FixturePaymentProvider } from '../../payments/src/adapters/fixture.ts';
import type { SqlExecutor } from '../../operations/src/sql-executor.ts';
import { startApplication } from '../src/application.ts';

describe('start-up', () => {
  test('refuses to start when the database does not answer', async () => {
    const sql: SqlExecutor = async () => '';
    await assert.rejects(startApplication({ sql, provider: new FixturePaymentProvider('s') }), /did not answer/);
  });

  test('refuses to start when a payment function is missing', async () => {
    const sql: SqlExecutor = async (statement: string) => {
      if (statement === 'select 1;') return '1';
      return 'public.app_payment_start(uuid, text, text, bigint, bpchar, timestamptz)';
    };
    await assert.rejects(startApplication({ sql, provider: new FixturePaymentProvider('s') }), /missing required functions/);
  });

  test('starts when every function is present', async () => {
    const sql: SqlExecutor = async (statement: string) => (statement === 'select 1;' ? '1' : '');
    const app = await startApplication({ sql, provider: new FixturePaymentProvider('s') });
    assert.ok(app.ledger);
    assert.ok(app.authority);
  });
});

describe('the composition root is not wired to non-authoritative flows', () => {
  test('it does not import the in-memory payment flow, webhook, store, or the fulfilment orchestrator', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(fileURLToPath(new URL('../src/application.ts', import.meta.url)), 'utf8');
    for (const forbidden of ['payment-flow.ts', 'payments/src/webhook.ts', 'payments/src/store.ts', 'fulfilment/src/orchestrator.ts', 'fulfilment/src/store.ts']) {
      assert.equal(source.includes(forbidden), false, `application.ts must not import ${forbidden}`);
    }
  });
});
