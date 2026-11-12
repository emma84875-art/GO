import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { money } from '../src/money.ts';
import { convertMoney, applyFees, priceBreakdown, type FxRateSnapshot } from '../src/pricing.ts';
import { validatePassenger, ageOn, passengerTypeFor } from '../src/passenger.ts';
import { idempotencyKey, nextAttempt } from '../src/idempotency.ts';

const usdToNgn: FxRateSnapshot = {
  from: 'USD',
  to: 'NGN',
  rateScaled: 1_500_00000000n, // 1 USD = 1500.00000000 NGN
  capturedAtUtc: '2026-11-12T05:00:00Z',
};

describe('currency conversion', () => {
  test('converts USD cents to NGN kobo with an exact rate', () => {
    // $100.00 = 10,000 cents -> 150,000.00 NGN = 15,000,000 kobo
    assert.deepEqual(convertMoney(money(10_000, 'USD'), usdToNgn), money(15_000_000, 'NGN'));
  });

  test('rounds half-up on the minor unit', () => {
    // rate 1.005 NGN per cent-equivalent test: 1 cent * 1.005 = 1.005 -> rounds to 1
    const rate: FxRateSnapshot = { ...usdToNgn, rateScaled: 100_500_000n, to: 'NGN' };
    assert.equal(convertMoney(money(1, 'USD'), rate).amountMinor, 1);
    // 3 * 1.005 = 3.015 -> 3
    assert.equal(convertMoney(money(3, 'USD'), rate).amountMinor, 3);
    // 5 * 0.5 = 2.5 -> 3 (half up)
    const half: FxRateSnapshot = { ...usdToNgn, rateScaled: 50_000_000n };
    assert.equal(convertMoney(money(5, 'USD'), half).amountMinor, 3);
  });

  test('refuses a rate snapshot for the wrong currency', () => {
    assert.throws(() => convertMoney(money(100, 'GBP'), usdToNgn), TypeError);
  });

  test('refuses a non-positive rate', () => {
    assert.throws(() => convertMoney(money(100, 'USD'), { ...usdToNgn, rateScaled: 0n }), RangeError);
  });
});

describe('fees', () => {
  test('applies basis points and a fixed fee, rounded half-up', () => {
    // 1.5% of 15,000,000 kobo = 225,000; plus fixed 50,000 kobo
    const { fee, total } = applyFees(money(15_000_000, 'NGN'), {
      serviceFeeBasisPoints: 150,
      fixedFeeMinor: 50_000,
    });
    assert.equal(fee.amountMinor, 275_000);
    assert.equal(total.amountMinor, 15_275_000);
  });

  test('rounds the percentage half-up', () => {
    // 1 bp of 50 minor units = 0.005 -> rounds to 0 (below half); 100 bp of 50 = 0.5 -> 1
    assert.equal(applyFees(money(50, 'NGN'), { serviceFeeBasisPoints: 1, fixedFeeMinor: 0 }).fee.amountMinor, 0);
    assert.equal(applyFees(money(50, 'NGN'), { serviceFeeBasisPoints: 100, fixedFeeMinor: 0 }).fee.amountMinor, 1);
  });

  test('rejects fractional basis points', () => {
    assert.throws(() => applyFees(money(100, 'NGN'), { serviceFeeBasisPoints: 1.5, fixedFeeMinor: 0 }), RangeError);
  });
});

describe('price breakdown', () => {
  test('shows supplier cost, converted base, fee and customer total consistently', () => {
    const result = priceBreakdown(money(40_000, 'USD'), usdToNgn, {
      serviceFeeBasisPoints: 200,
      fixedFeeMinor: 0,
    });
    assert.equal(result.supplierCost.currency, 'USD');
    // $400.00 (40,000 cents) at 1,500 NGN per USD = NGN 600,000.00 = 60,000,000 kobo
    assert.equal(result.convertedBase.amountMinor, 60_000_000);
    assert.equal(result.customerTotal.amountMinor, result.convertedBase.amountMinor + result.serviceFee.amountMinor);
    assert.equal(result.fxRate, usdToNgn);
  });
});

describe('passenger validation', () => {
  const travel = '2026-12-01';
  const valid = { firstName: 'Ada', lastName: "O'Neil-Okafor", dateOfBirth: '1990-05-14', nationality: 'NG' };

  test('accepts a valid adult', () => {
    const result = validatePassenger(valid, travel);
    assert.equal(result.valid, true);
    assert.equal(result.passengerType, 'adult');
  });

  test('accepts names with accents and non-Latin letters', () => {
    const result = validatePassenger({ ...valid, firstName: 'José', lastName: 'Müller' }, travel);
    assert.equal(result.valid, true);
  });

  test('rejects digits and symbols in names', () => {
    const result = validatePassenger({ ...valid, firstName: 'Ada1' }, travel);
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), /First name contains/);
  });

  test('rejects impossible dates and future birth dates', () => {
    assert.equal(validatePassenger({ ...valid, dateOfBirth: '1990-02-30' }, travel).valid, false);
    assert.equal(validatePassenger({ ...valid, dateOfBirth: '2027-01-01' }, travel).valid, false);
    assert.equal(validatePassenger({ ...valid, dateOfBirth: '1899-12-31' }, travel).valid, false);
  });

  test('rejects malformed nationality', () => {
    assert.equal(validatePassenger({ ...valid, nationality: 'Nigeria' }, travel).valid, false);
    assert.equal(validatePassenger({ ...valid, nationality: 'ng' }, travel).valid, false);
  });

  test('derives passenger type from age on the travel date', () => {
    assert.equal(ageOn('2010-12-02', '2026-12-01'), 15);
    assert.equal(ageOn('2010-12-01', '2026-12-01'), 16);
    assert.equal(passengerTypeFor(1), 'infant');
    assert.equal(passengerTypeFor(2), 'child');
    assert.equal(passengerTypeFor(11), 'child');
    assert.equal(passengerTypeFor(12), 'adult');
  });
});

describe('idempotency keys', () => {
  const booking = '0b0e3c3a-1111-4d2a-9f00-abcdef012345';

  test('is stable for the same operation and attempt', () => {
    assert.equal(idempotencyKey(booking, 'payment_capture'), idempotencyKey(booking, 'payment_capture'));
  });

  test('differs between operations and between attempts', () => {
    assert.notEqual(idempotencyKey(booking, 'payment_capture'), idempotencyKey(booking, 'payment_release'));
    assert.notEqual(idempotencyKey(booking, 'supplier_ticket', 1), idempotencyKey(booking, 'supplier_ticket', 2));
  });

  test('normalises booking IDs to lower case', () => {
    assert.equal(
      idempotencyKey(booking.toUpperCase(), 'refund'),
      idempotencyKey(booking, 'refund'),
    );
  });

  test('rejects unknown operations, bad IDs and bad attempts', () => {
    assert.throws(() => idempotencyKey(booking, 'charge_card' as never), TypeError);
    assert.throws(() => idempotencyKey('not-a-uuid', 'refund'), TypeError);
    assert.throws(() => idempotencyKey(booking, 'refund', 0), RangeError);
    assert.equal(nextAttempt(1), 2);
  });
});
