import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { money, addMoney, sumMoney, formatMoney } from '../src/money.ts';
import { formatLocalTime, durationMinutes } from '../src/time.ts';

describe('money', () => {
  test('stores integer minor units with a currency', () => {
    assert.deepEqual(money(12345, 'NGN'), { amountMinor: 12345, currency: 'NGN' });
  });

  test('rejects floats and unsafe integers', () => {
    assert.throws(() => money(10.5, 'USD'), TypeError);
    assert.throws(() => money(Number.MAX_SAFE_INTEGER + 2, 'USD'), TypeError);
  });

  test('rejects unsupported currencies', () => {
    assert.throws(() => money(100, 'XYZ' as never), TypeError);
  });

  test('refuses to add different currencies without an explicit conversion', () => {
    assert.throws(() => addMoney(money(100, 'USD'), money(100, 'NGN')), TypeError);
  });

  test('sums values in the same currency', () => {
    assert.deepEqual(sumMoney([money(100, 'GBP'), money(250, 'GBP')], 'GBP'), money(350, 'GBP'));
  });

  test('formats using the currency minor-unit exponent', () => {
    const formatted = formatMoney(money(123456, 'NGN'), 'en-NG');
    assert.equal(formatted, 'NGN 1,234.56');
  });
});

describe('time', () => {
  test('displays a UTC instant in the airport zone', () => {
    // 08:00 UTC is 09:00 in Lagos (UTC+1, no DST) and 08:00 in London in November (GMT).
    const lagos = formatLocalTime('2026-11-12T08:00:00Z', 'Africa/Lagos');
    const london = formatLocalTime('2026-11-12T08:00:00Z', 'Europe/London');
    assert.match(lagos, /09:00/);
    assert.match(london, /08:00/);
  });

  test('computes durations and rejects reversed times', () => {
    assert.equal(durationMinutes('2026-11-12T08:00:00Z', '2026-11-12T15:05:00Z'), 425);
    assert.throws(() => durationMinutes('2026-11-12T10:00:00Z', '2026-11-12T08:00:00Z'), RangeError);
  });
});
