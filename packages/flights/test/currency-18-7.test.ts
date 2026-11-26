// Phase 18.7: Duffel responses in any valid ISO 4217 currency. Fixtures are SYNTHETIC. Every amount is read as
// integer minor units from its own exponent. No amount is converted, and no currency is relabelled.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseDuffelResult, parseDecimalToMinor } from '../src/adapters/duffel.ts';
import { SupplierUnavailableError } from '../src/supplier.ts';

const SEGMENT = {
  departing_at: '2026-12-01T08:00:00',
  arriving_at: '2026-12-01T15:05:00',
  origin: { iata_code: 'LOS', time_zone: 'Africa/Lagos' },
  destination: { iata_code: 'LHR', time_zone: 'Europe/London' },
  marketing_carrier: { iata_code: 'XX' },
  marketing_carrier_flight_number: '100',
};

function offer(id: string, amount: unknown, currency: unknown): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    id,
    total_amount: amount,
    expires_at: '2026-11-30T12:00:00Z',
    slices: [{ segments: [SEGMENT] }],
    passengers: [{ baggages: [{ type: 'checked', quantity: 1 }] }],
  };
  if (currency !== undefined) raw.total_currency = currency;
  return raw;
}

const payload = (...offers: Record<string, unknown>[]) => ({ data: { offers } });

describe('Phase 18.7: decimal parsing uses the exponent and never rounds', () => {
  test('zero-decimal JPY accepts whole and zero-padded amounts', () => {
    assert.equal(parseDecimalToMinor('15000', 0), 15000);
    assert.equal(parseDecimalToMinor('15000.00', 0), 15000);
  });

  test('three-decimal KWD keeps all three digits', () => {
    assert.equal(parseDecimalToMinor('12.500', 3), 12500);
    assert.equal(parseDecimalToMinor('0.001', 3), 1);
  });

  test('two-decimal NGN and USD, including exact cents', () => {
    assert.equal(parseDecimalToMinor('450000.00', 2), 45000000);
    assert.equal(parseDecimalToMinor('0.10', 2), 10);
    assert.equal(parseDecimalToMinor('1234567.89', 2), 123456789);
  });

  test('a non-zero digit beyond the exponent is refused, never rounded', () => {
    assert.throws(() => parseDecimalToMinor('12.5', 0), SupplierUnavailableError);
    assert.throws(() => parseDecimalToMinor('12.5001', 3), SupplierUnavailableError);
    assert.throws(() => parseDecimalToMinor('1.005', 2), SupplierUnavailableError);
  });

  test('an amount beyond the safe integer range is refused', () => {
    assert.throws(() => parseDecimalToMinor('99999999999999999.00', 2), SupplierUnavailableError);
  });
});

describe('Phase 18.7: the regression currencies keep their amounts and codes', () => {
  test('NGN, USD, GBP, EUR, JPY and KWD each keep their own exponent and code', () => {
    const result = normaliseDuffelResult(payload(
      offer('ngn', '450000.00', 'NGN'),
      offer('usd', '450.00', 'USD'),
      offer('gbp', '10.05', 'GBP'),
      offer('eur', '12.00', 'EUR'),
      offer('jpy', '15000', 'JPY'),
      offer('kwd', '12.500', 'KWD'),
    ), 'NGN');
    const byId = Object.fromEntries(result.offers.map((o) => [o.id, o.supplierPrice]));
    assert.deepEqual(byId.ngn, { amountMinor: 45000000, currency: 'NGN' });
    assert.deepEqual(byId.usd, { amountMinor: 45000, currency: 'USD' });
    assert.deepEqual(byId.gbp, { amountMinor: 1005, currency: 'GBP' });
    assert.deepEqual(byId.eur, { amountMinor: 1200, currency: 'EUR' });
    assert.deepEqual(byId.jpy, { amountMinor: 15000, currency: 'JPY' });
    assert.deepEqual(byId.kwd, { amountMinor: 12500, currency: 'KWD' });
    assert.deepEqual(result.excluded, { invalidCurrency: 0, currencies: [], invalidPrice: 0, malformed: 0 });
  });

  test('a JPY fare is not multiplied by 100', () => {
    const [only] = normaliseDuffelResult(payload(offer('jpy', '15000', 'JPY')), 'NGN').offers;
    assert.equal(only.displayPrice.amountMinor, 15000);
  });

  test('a zero-decimal amount written with .00 is accepted', () => {
    const [only] = normaliseDuffelResult(payload(offer('jpy', '15000.00', 'JPY')), 'NGN').offers;
    assert.equal(only.supplierPrice.amountMinor, 15000);
  });

  test('a fare in a currency with no conversion keeps its supplier currency', () => {
    const [only] = normaliseDuffelResult(payload(offer('kwd', '12.500', 'KWD')), 'NGN').offers;
    assert.equal(only.displayPrice.currency, 'KWD');
    assert.equal(only.displayPrice.amountMinor, 12500);
  });
});

describe('Phase 18.7: large and very small amounts', () => {
  test('very small amounts are read exactly', () => {
    const result = normaliseDuffelResult(payload(offer('a', '0.01', 'NGN'), offer('b', '0.001', 'KWD')), 'NGN');
    assert.deepEqual(result.offers.map((o) => o.supplierPrice.amountMinor), [1, 1]);
  });

  test('a large amount that is still a safe integer is read exactly', () => {
    const [only] = normaliseDuffelResult(payload(offer('big', '1234567890.12', 'NGN')), 'NGN').offers;
    assert.equal(only.supplierPrice.amountMinor, 123456789012);
  });

  test('an amount too large to represent is excluded and counted, not shown', () => {
    const result = normaliseDuffelResult(payload(offer('huge', '99999999999999999.00', 'NGN')), 'NGN');
    assert.equal(result.offers.length, 0);
    assert.equal(result.excluded.invalidPrice, 1);
  });
});

describe('Phase 18.7: invalid currency codes are excluded and counted', () => {
  test('a lowercase, two-letter, four-letter or unknown code is excluded', () => {
    const result = normaliseDuffelResult(payload(
      offer('lower', '100.00', 'ngn'),
      offer('two', '100.00', 'NG'),
      offer('four', '100.00', 'NGNN'),
      offer('unknown', '100.00', 'ZZZ'),
    ), 'NGN');
    assert.equal(result.offers.length, 0);
    assert.equal(result.excluded.invalidCurrency, 4);
  });

  test('a code with a valid shape that is not displayable is reported by its code', () => {
    const result = normaliseDuffelResult(payload(offer('iqd', '1000.000', 'UYW')), 'NGN');
    assert.equal(result.excluded.invalidCurrency, 1);
    assert.deepEqual(result.excluded.currencies, ['UYW']);
  });

  test('a code that is not three capital letters is counted but never echoed', () => {
    const result = normaliseDuffelResult(payload(offer('html', '100.00', '<b>NGN</b>')), 'NGN');
    assert.equal(result.excluded.invalidCurrency, 1);
    assert.deepEqual(result.excluded.currencies, []);
  });

  test('a missing currency is excluded and counted', () => {
    const result = normaliseDuffelResult(payload(offer('none', '100.00', undefined)), 'NGN');
    assert.equal(result.offers.length, 0);
    assert.equal(result.excluded.invalidCurrency, 1);
  });

  test('a non-string currency is excluded and counted', () => {
    const result = normaliseDuffelResult(payload(offer('num', '100.00', 840)), 'NGN');
    assert.equal(result.excluded.invalidCurrency, 1);
  });
});

describe('Phase 18.7: missing, negative, zero and malformed amounts are excluded and counted', () => {
  test('each bad amount is excluded and counted as invalidPrice', () => {
    const result = normaliseDuffelResult(payload(
      offer('missing', undefined, 'NGN'),
      offer('negative', '-5.00', 'NGN'),
      offer('zero', '0.00', 'NGN'),
      offer('zero_jpy', '0', 'JPY'),
      offer('text', 'abc', 'NGN'),
      offer('number', 450, 'NGN'),
      offer('extra_digit', '12.5', 'JPY'),
      offer('empty', '', 'NGN'),
    ), 'NGN');
    assert.equal(result.offers.length, 0);
    assert.equal(result.excluded.invalidPrice, 8);
    assert.equal(result.excluded.invalidCurrency, 0);
  });

  test('good offers are kept beside the excluded ones', () => {
    const result = normaliseDuffelResult(payload(offer('good', '450.00', 'USD'), offer('zero', '0', 'USD')), 'NGN');
    assert.deepEqual(result.offers.map((o) => o.id), ['good']);
    assert.equal(result.excluded.invalidPrice, 1);
  });
});

describe('Phase 18.7: mixed currencies, and every offer excluded', () => {
  test('a mixed batch keeps each offer in its own currency and reports nothing as converted', () => {
    const result = normaliseDuffelResult(payload(
      offer('a', '450000.00', 'NGN'),
      offer('b', '450.00', 'USD'),
      offer('c', '15000', 'JPY'),
      offer('d', '12.500', 'KWD'),
      offer('e', '1.00', 'UYW'),
    ), 'NGN');
    assert.deepEqual(
      result.offers.map((o) => [o.id, o.displayPrice.currency, o.supplierPrice.currency]),
      [['a', 'NGN', 'NGN'], ['b', 'USD', 'USD'], ['c', 'JPY', 'JPY'], ['d', 'KWD', 'KWD']],
    );
    assert.deepEqual(result.excluded, { invalidCurrency: 1, currencies: ['UYW'], invalidPrice: 0, malformed: 0 });
  });

  test('when every offer is excluded the result is empty with the counts, not an error', () => {
    const result = normaliseDuffelResult(payload(
      offer('iqd', '1000.000', 'UYW'),
      offer('zero', '0', 'NGN'),
    ), 'NGN');
    assert.equal(result.offers.length, 0);
    assert.deepEqual(result.excluded, { invalidCurrency: 1, currencies: ['UYW'], invalidPrice: 1, malformed: 0 });
  });
});

describe('Phase 18.7 correction pass: malformed offers never break valid ones', () => {
  test('each kind of malformed offer is counted and skipped, and the valid offers are kept', () => {
    const notObject = 'not an offer';
    const result = normaliseDuffelResult(payload(
      offer('good_1', '450.00', 'USD'),
      notObject as unknown as Record<string, unknown>,
      { ...offer('no_id', '450.00', 'USD'), id: undefined },
      { ...offer('bad_expiry', '450.00', 'USD'), expires_at: 'not a date' },
      { ...offer('no_slices', '450.00', 'USD'), slices: [] },
      { ...offer('bad_segment', '450.00', 'USD'), slices: [{ segments: [{ origin: 'LOS' }] }] },
      offer('good_2', '15000', 'JPY'),
    ), 'NGN');
    assert.deepEqual(result.offers.map((o) => o.id), ['good_1', 'good_2']);
    assert.deepEqual(result.excluded, { invalidCurrency: 0, currencies: [], invalidPrice: 0, malformed: 5 });
  });

  test('a response in which every offer is malformed is answered with no offers and the count, not an error', () => {
    const result = normaliseDuffelResult(payload({ ...offer('x', '1.00', 'USD'), slices: [] }), 'NGN');
    assert.equal(result.offers.length, 0);
    assert.deepEqual(result.excluded, { invalidCurrency: 0, currencies: [], invalidPrice: 0, malformed: 1 });
  });

  test('a response with no offers array at all is still refused as invalid_response', () => {
    assert.throws(() => normaliseDuffelResult({ data: {} }, 'NGN'), SupplierUnavailableError);
  });

  test('malformed, bad-currency, bad-price and good offers in one batch are each counted in the right place', () => {
    const result = normaliseDuffelResult(payload(
      offer('ok', '450.00', 'USD'),
      { ...offer('m', '450.00', 'USD'), slices: [] },
      offer('c', '450.00', 'UYW'),
      offer('p', '0', 'USD'),
    ), 'NGN');
    assert.deepEqual(result.offers.map((o) => o.id), ['ok']);
    assert.deepEqual(result.excluded, { invalidCurrency: 1, currencies: ['UYW'], invalidPrice: 1, malformed: 1 });
  });
});

describe('List One corrections: VED, VES, legacy and fund codes in supplier offers', () => {
  test('VED and VES offers are both kept, each in its own currency, with no conversion', () => {
    const result = normaliseDuffelResult(payload(
      offer('ved', '1234.56', 'VED'),
      offer('ves', '1234.56', 'VES'),
    ), 'NGN');
    assert.deepEqual(
      result.offers.map((o) => [o.id, o.supplierPrice.currency, o.supplierPrice.amountMinor]),
      [['ved', 'VED', 123456], ['ves', 'VES', 123456]],
    );
    assert.deepEqual(result.excluded, { invalidCurrency: 0, currencies: [], invalidPrice: 0, malformed: 0 });
  });

  test('legacy codes are excluded from new supplier offers and counted with their codes', () => {
    const result = normaliseDuffelResult(payload(
      offer('ang', '100.00', 'ANG'),
      offer('bgn', '100.00', 'BGN'),
      offer('cuc', '100.00', 'CUC'),
      offer('sll', '100.00', 'SLL'),
      offer('zwl', '100.00', 'ZWL'),
      offer('hrk', '100.00', 'HRK'),
    ), 'NGN');
    assert.equal(result.offers.length, 0);
    assert.equal(result.excluded.invalidCurrency, 6);
    assert.deepEqual(result.excluded.currencies, ['ANG', 'BGN', 'CUC', 'HRK', 'SLL', 'ZWL']);
  });

  test('fund and special codes from a supplier are excluded and counted, not shown', () => {
    const result = normaliseDuffelResult(payload(
      offer('uyw', '100.00', 'UYW'),
      offer('xau', '1.00', 'XAU'),
      offer('ok', '450.00', 'USD'),
    ), 'NGN');
    assert.deepEqual(result.offers.map((o) => o.id), ['ok']);
    assert.deepEqual(result.excluded, { invalidCurrency: 2, currencies: ['UYW', 'XAU'], invalidPrice: 0, malformed: 0 });
  });

  test('the 13 corrected currencies are accepted with their two-decimal amounts', () => {
    const codes = ['AFN', 'ALL', 'COP', 'HUF', 'IDR', 'KPW', 'LAK', 'LBP', 'MMK', 'PKR', 'SOS', 'SYP', 'YER'];
    const result = normaliseDuffelResult(payload(...codes.map((c) => offer(c, '1500.00', c))), 'NGN');
    assert.equal(result.offers.length, 13);
    assert.ok(result.offers.every((o) => o.supplierPrice.amountMinor === 150000));
  });
});
