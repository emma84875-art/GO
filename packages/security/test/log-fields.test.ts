import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { safeLogFields } from '../src/log-fields.ts';

const ALLOWED = ['route', 'status', 'ticketNumber', 'passengerCount', 'note', 'paid', 'email', 'retries'] as const;

describe('safeLogFields', () => {
  test('keeps allowlisted keys and drops everything else', () => {
    const out = safeLogFields(
      { route: 'LOS-LHR', status: 'ok', secretName: 'Ada Lovelace', passengerCount: 2 },
      ALLOWED,
    );
    assert.deepEqual(out, { route: 'LOS-LHR', status: 'ok', passengerCount: 2 });
    assert.equal(JSON.stringify(out).includes('Ada'), false);
  });

  test('output keys are always a subset of the allowlist', () => {
    const input: Record<string, unknown> = { route: 'a', extra: 'b', constructor: 'c', __proto__x: 'd', status: 'e' };
    const out = safeLogFields(input, ALLOWED);
    for (const key of Object.keys(out)) {
      assert.ok(ALLOWED.includes(key as (typeof ALLOWED)[number]), `unexpected key ${key}`);
    }
  });

  test('does not pick up inherited properties', () => {
    const out = safeLogFields({}, ['constructor', 'toString']);
    assert.deepEqual(out, {});
  });

  test('redacts an email address inside an allowed value', () => {
    const out = safeLogFields({ note: 'contact ada@example.com about the change' }, ALLOWED);
    assert.equal(out.note, 'contact [email] about the change');
    assert.equal(JSON.stringify(out).includes('example.com'), false);
  });

  test('redacts an email even under an allowed key whose name suggests nothing', () => {
    const out = safeLogFields({ status: 'sent to a.b+c@mail.co.uk' }, ALLOWED);
    assert.equal(out.status, 'sent to [email]');
  });

  test('redacts a ticket-like value under a ticketNumber key', () => {
    const out = safeLogFields({ ticketNumber: 'ET8K2P9QLM' }, ALLOWED);
    assert.equal(out.ticketNumber, '[document]');
    assert.equal(JSON.stringify(out).includes('ET8K2P9QLM'), false);
  });

  test('does not apply the document rule to plain words under a document key', () => {
    const out = safeLogFields({ ticketNumber: 'refund issued' }, ALLOWED);
    assert.equal(out.ticketNumber, 'refund issued');
  });

  test('redacts a run of nine or more digits in any string value', () => {
    const out = safeLogFields({ note: 'bank ref 123456789 received' }, ALLOWED);
    assert.equal(out.note, 'bank ref [number] received');
  });

  test('does not redact short digit runs', () => {
    const out = safeLogFields({ note: 'gate 12345678 seat 4' }, ALLOWED);
    assert.equal(out.note, 'gate 12345678 seat 4');
  });

  test('redacts a long number passed as a number value', () => {
    const out = safeLogFields({ retries: 123456789012 }, ALLOWED);
    assert.equal(out.retries, '[number]');
  });

  test('drops nested objects, arrays and functions without recursing', () => {
    const out = safeLogFields(
      {
        route: { origin: 'LOS', passenger: 'Ada' },
        note: ['ada@example.com'],
        status: () => 'ok',
        paid: true,
      },
      ALLOWED,
    );
    assert.deepEqual(out, { paid: true });
    assert.equal(JSON.stringify(out).includes('Ada'), false);
  });

  test('turns non-finite numbers into null', () => {
    const out = safeLogFields({ retries: Number.NaN, passengerCount: Number.POSITIVE_INFINITY }, ALLOWED);
    assert.deepEqual(out, { retries: null, passengerCount: null });
  });

  test('keeps finite numbers, booleans and null', () => {
    const out = safeLogFields({ passengerCount: 3, paid: false, note: null }, ALLOWED);
    assert.deepEqual(out, { passengerCount: 3, paid: false, note: null });
  });

  test('drops undefined and missing keys', () => {
    const out = safeLogFields({ route: undefined }, ALLOWED);
    assert.deepEqual(out, {});
  });
});
