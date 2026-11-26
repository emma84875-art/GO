// Phase 18.7: any valid ISO 4217 code is accepted, the decimal places come from the ISO exponent, and amounts are
// formatted from integers with string operations only. Expected strings are written out by hand.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { addMoney, formatMoney, historicalMoney, isCurrencyCode, isKnownCurrencyCode, minorUnitExponent, money } from '../src/money.ts';
import { CURRENCY_ENTRIES, CURRENCY_METADATA_PUBLISHED, CURRENCY_METADATA_RETRIEVED_UTC, CURRENCY_METADATA_SOURCE, CURRENCY_METADATA_VERSION } from '../src/currency-metadata.ts';

describe('Phase 18.7: currency codes', () => {
  test('the codes in the regression set are accepted', () => {
    for (const code of ['NGN', 'USD', 'GBP', 'EUR', 'JPY', 'KWD', 'CHF', 'BHD', 'KRW']) {
      assert.equal(isCurrencyCode(code), true, code);
    }
  });

  test('malformed and unknown codes are refused', () => {
    for (const code of ['ngn', 'NG', 'NGNN', 'N1G', ' NGN', 'NGN ', 'XXX', 'ZZZ', '<b>', '', null, undefined, 840, {}]) {
      assert.equal(isCurrencyCode(code), false, String(code));
    }
  });

  test('the four owner-corrected codes are current with the owner-decided minor units', () => {
    assert.equal(isCurrencyCode('IQD'), true);
    assert.equal(isCurrencyCode('IRR'), true);
    assert.equal(isCurrencyCode('MGA'), true);
    assert.equal(isCurrencyCode('RWF'), true);
    assert.equal(minorUnitExponent('IQD'), 3);
    assert.equal(minorUnitExponent('IRR'), 2);
    assert.equal(minorUnitExponent('MGA'), 2);
    assert.equal(minorUnitExponent('RWF'), 0);
  });

  test('funds and special-purpose codes are refused for new and stored amounts', () => {
    for (const code of ['UYW', 'CLF', 'CHE', 'XAU', 'XDR', 'XSU', 'XXX']) {
      assert.equal(isCurrencyCode(code), false, code);
      assert.equal(isKnownCurrencyCode(code), false, code);
    }
  });

  test('withdrawn codes are refused', () => {
    assert.equal(isCurrencyCode('HRK'), false);
  });

  test('money() refuses an invalid code and a non-integer amount', () => {
    assert.throws(() => money(100, 'ngn'), TypeError);
    assert.throws(() => money(1.5, 'NGN'), TypeError);
    assert.throws(() => money(Number.MAX_SAFE_INTEGER + 2, 'NGN'), TypeError);
  });

  test('money() accepts any valid ISO code, not only the original four', () => {
    assert.deepEqual(money(15000, 'JPY'), { amountMinor: 15000, currency: 'JPY' });
  });
});

describe('Phase 18.7: minor-unit exponents', () => {
  test('the exponents come from ISO for the regression set', () => {
    assert.equal(minorUnitExponent('NGN'), 2);
    assert.equal(minorUnitExponent('USD'), 2);
    assert.equal(minorUnitExponent('GBP'), 2);
    assert.equal(minorUnitExponent('EUR'), 2);
    assert.equal(minorUnitExponent('JPY'), 0);
    assert.equal(minorUnitExponent('KWD'), 3);
  });

  test('an unknown code throws rather than returning a guess', () => {
    assert.throws(() => minorUnitExponent('UYW'), TypeError);
    assert.throws(() => minorUnitExponent('XXX'), TypeError);
  });
});

describe('Phase 18.7: formatting is exact and keeps the code', () => {
  test('NGN, USD, JPY and KWD examples from the brief', () => {
    assert.equal(formatMoney(money(45_000_000, 'NGN')), 'NGN 450,000.00');
    assert.equal(formatMoney(money(45_000, 'USD')), 'USD 450.00');
    assert.equal(formatMoney(money(15_000, 'JPY')), 'JPY 15,000');
    assert.equal(formatMoney(money(12_500, 'KWD')), 'KWD 12.500');
  });

  test('GBP and EUR use two decimal places', () => {
    assert.equal(formatMoney(money(1_005, 'GBP')), 'GBP 10.05');
    assert.equal(formatMoney(money(12_345, 'EUR')), 'EUR 123.45');
  });

  test('a zero-decimal currency has no decimal point', () => {
    assert.equal(formatMoney(money(0, 'JPY')), 'JPY 0');
    assert.equal(formatMoney(money(1, 'JPY')), 'JPY 1');
  });

  test('a three-decimal currency keeps all three digits, even very small amounts', () => {
    assert.equal(formatMoney(money(1, 'KWD')), 'KWD 0.001');
    assert.equal(formatMoney(money(10, 'KWD')), 'KWD 0.010');
  });

  test('zero and very small two-decimal amounts', () => {
    assert.equal(formatMoney(money(0, 'NGN')), 'NGN 0.00');
    assert.equal(formatMoney(money(1, 'USD')), 'USD 0.01');
  });

  test('a large amount is exact, with no float rounding', () => {
    assert.equal(formatMoney(money(99_999_999_999, 'NGN')), 'NGN 999,999,999.99');
    assert.equal(formatMoney(money(Number.MAX_SAFE_INTEGER, 'JPY')), 'JPY 9,007,199,254,740,991');
  });

  test('a negative amount keeps its sign and its precision', () => {
    assert.equal(formatMoney(money(-5, 'GBP')), 'GBP -0.05');
  });

  test('the code is never changed by formatting', () => {
    assert.equal(formatMoney(money(12_500, 'KWD')).slice(0, 3), 'KWD');
  });
});

describe('Phase 18.7: no arithmetic across currencies', () => {
  test('adding JPY to NGN is refused', () => {
    assert.throws(() => addMoney(money(1, 'JPY'), money(1, 'NGN')), TypeError);
  });
});

describe('Phase 18.7 correction pass: historical codes, unlisted codes and the shared table', () => {
  test('HRK is a legacy code: refused for new amounts, still formatted for stored records', () => {
    assert.equal(isCurrencyCode('HRK'), false);
    assert.equal(isKnownCurrencyCode('HRK'), true);
    assert.throws(() => money(100, 'HRK'), TypeError);
    assert.equal(formatMoney(historicalMoney(100, 'HRK')), 'HRK 1.00');
    assert.equal(formatMoney(historicalMoney(12345, 'HRK')), 'HRK 123.45');
  });

  test('a historical amount still refuses codes that are not in the table at all', () => {
    assert.throws(() => historicalMoney(100, 'UYW'), TypeError);
    assert.equal(isKnownCurrencyCode('UYW'), false);
  });

  test('VED is an ordinary current currency; UYW and CLF are funds and stay refused', () => {
    assert.equal(isCurrencyCode('VED'), true);
    assert.equal(isCurrencyCode('UYW'), false);
    assert.equal(isCurrencyCode('CLF'), false);
  });

  test('the table carries its source, status and version', () => {
    assert.match(CURRENCY_METADATA_SOURCE, /SIX Group/);
    assert.match(CURRENCY_METADATA_SOURCE, /2026-09-17/);
    assert.equal(CURRENCY_METADATA_PUBLISHED, '2026-09-17');
    assert.equal(CURRENCY_METADATA_RETRIEVED_UTC, '2026-11-26');
    assert.equal(CURRENCY_METADATA_VERSION, 'six-list-one-2026-09-17');
  });

  test('every table entry has a valid shape; ordinary currencies have an exponent between 0 and 4', () => {
    for (const entry of CURRENCY_ENTRIES) {
      assert.match(entry.code, /^[A-Z]{3}$/, entry.code);
      if (entry.classification === 'currency') {
        assert.ok(Number.isInteger(entry.exponent) && entry.exponent >= 0 && entry.exponent <= 4, entry.code);
      }
    }
  });
});
