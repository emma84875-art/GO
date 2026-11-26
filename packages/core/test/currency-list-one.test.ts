// Checks the currency table against the committed SIX ISO 4217 List One XML (publication 2026-09-17).
// The XML is the authority. Expected values below are written out by hand from the XML and the owner's decisions.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CURRENCY_ENTRIES, CURRENCY_METADATA_PUBLISHED, CURRENCY_METADATA_SOURCE } from '../src/currency-metadata.ts';
import { formatMoney, historicalMoney, isCurrencyCode, isKnownCurrencyCode, minorUnitExponent, money } from '../src/money.ts';

const XML = readFileSync(new URL('../data/iso-4217-list-one-2026-09-17.xml', import.meta.url), 'utf8');

function officialEntries(): Map<string, { name: string; number: string; units: string; fund: boolean }> {
  const out = new Map<string, { name: string; number: string; units: string; fund: boolean }>();
  for (const [, block] of XML.matchAll(/<CcyNtry>([\s\S]*?)<\/CcyNtry>/g)) {
    const code = (block.match(/<Ccy>([^<]*)<\/Ccy>/) ?? [])[1];
    if (!code) continue;
    const name = (block.match(/<CcyNm[^>]*>([^<]*)<\/CcyNm>/) ?? [])[1] ?? '';
    const number = (block.match(/<CcyNbr>([^<]*)<\/CcyNbr>/) ?? [])[1] ?? '';
    const units = (block.match(/<CcyMnrUnts>([^<]*)<\/CcyMnrUnts>/) ?? [])[1] ?? '';
    out.set(code, { name, number, units, fund: /<CcyNm IsFund="true">/.test(block) });
  }
  return out;
}

const OFFICIAL = officialEntries();
const TABLE = new Map(CURRENCY_ENTRIES.map((e) => [e.code, e]));

describe('the committed XML and the table', () => {
  test('the XML is the List One published 2026-09-17 with 178 distinct codes', () => {
    assert.match(XML, /<ISO_4217 Pblshd="2026-09-17">/);
    assert.equal(OFFICIAL.size, 178);
    assert.equal(CURRENCY_METADATA_PUBLISHED, '2026-09-17');
    assert.match(CURRENCY_METADATA_SOURCE, /SIX Group/);
  });

  test('every official code is in the table, with the official classification and minor unit', () => {
    for (const [code, official] of OFFICIAL) {
      const entry = TABLE.get(code);
      assert.ok(entry, `missing from table: ${code}`);
      assert.equal(entry.number, official.number, `number ${code}`);
      assert.equal(entry.listStatus, 'current', `status ${code}`);
      if (official.fund) assert.equal(entry.classification, 'fund', code);
      else if (official.units === 'N.A.') assert.equal(entry.classification, 'special', code);
      else {
        assert.equal(entry.classification, 'currency', code);
        assert.equal(entry.exponent, Number(official.units), `exponent ${code}`);
      }
    }
  });

  test('every table entry that is not in the XML is a legacy code, never a current one', () => {
    const legacy = CURRENCY_ENTRIES.filter((e) => !OFFICIAL.has(e.code)).map((e) => e.code).sort();
    assert.deepEqual(legacy, ['ANG', 'BGN', 'CUC', 'HRK', 'SLL', 'ZWL']);
    for (const code of legacy) assert.equal(TABLE.get(code)?.listStatus, 'legacy', code);
  });
});

describe('the 13 corrected exponents (were 0, List One says 2)', () => {
  const CORRECTED = ['AFN', 'ALL', 'COP', 'HUF', 'IDR', 'KPW', 'LAK', 'LBP', 'MMK', 'PKR', 'SOS', 'SYP', 'YER'];
  test('each has 2 minor units and is a current currency', () => {
    for (const code of CORRECTED) {
      assert.equal(minorUnitExponent(code), 2, code);
      assert.equal(isCurrencyCode(code), true, code);
    }
  });
  test('each formats with two decimal places, exact', () => {
    assert.equal(formatMoney(money(150000, 'IDR')), 'IDR 1,500.00');
    assert.equal(formatMoney(money(12345, 'AFN')), 'AFN 123.45');
    assert.equal(formatMoney(money(1, 'LAK')), 'LAK 0.01');
    assert.equal(formatMoney(money(10000000, 'YER')), 'YER 100,000.00');
  });
});

describe('VED and VES are separate, ordinary, current currencies', () => {
  test('both are accepted for new amounts, each keeping its own code', () => {
    assert.equal(isCurrencyCode('VED'), true);
    assert.equal(isCurrencyCode('VES'), true);
    assert.equal(minorUnitExponent('VED'), 2);
    assert.equal(minorUnitExponent('VES'), 2);
  });
  test('they carry different official numbers and their own codes', () => {
    assert.equal(TABLE.get('VED')?.number, '926');
    assert.equal(TABLE.get('VES')?.number, '928');
  });
  test('formatting shows each code and never relabels one as the other', () => {
    assert.equal(formatMoney(money(123456, 'VED')), 'VED 1,234.56');
    assert.equal(formatMoney(money(123456, 'VES')), 'VES 1,234.56');
    assert.equal(money(1, 'VED').currency, 'VED');
    assert.equal(money(1, 'VES').currency, 'VES');
  });
  test('there is no alias or conversion between them in the table', () => {
    const names = CURRENCY_ENTRIES.map((e) => e.code);
    assert.equal(new Set(names).size, names.length);
    assert.throws(() => money(1, 'VEF'), TypeError);
  });
});

describe('legacy codes: refused for new amounts, readable for stored records', () => {
  const LEGACY = ['ANG', 'BGN', 'CUC', 'SLL', 'ZWL', 'HRK'];
  test('none is accepted for a new amount', () => {
    for (const code of LEGACY) {
      assert.equal(isCurrencyCode(code), false, code);
      assert.throws(() => money(100, code), TypeError);
    }
  });
  test('each is still recognised for a stored record', () => {
    for (const code of LEGACY) assert.equal(isKnownCurrencyCode(code), true, code);
  });
  test('historical amounts display with their code', () => {
    assert.equal(formatMoney(historicalMoney(12345, 'ANG')), 'ANG 123.45');
    assert.equal(formatMoney(historicalMoney(12345, 'BGN')), 'BGN 123.45');
    assert.equal(formatMoney(historicalMoney(12345, 'CUC')), 'CUC 123.45');
    assert.equal(formatMoney(historicalMoney(12345, 'ZWL')), 'ZWL 123.45');
  });
  test('HRK historical display: formatted as a stored record, exponent unverified', () => {
    assert.equal(formatMoney(historicalMoney(100, 'HRK')), 'HRK 1.00');
    assert.equal(formatMoney(historicalMoney(12345, 'HRK')), 'HRK 123.45');
    assert.equal(TABLE.get('HRK')?.provenance, 'legacy-not-in-list-one-unverified');
  });
  test('SLL is kept as a legacy code with its unverified exponent flagged', () => {
    assert.equal(TABLE.get('SLL')?.provenance, 'legacy-not-in-list-one-unverified');
    assert.equal(formatMoney(historicalMoney(12345, 'SLL')), 'SLL 12,345');
  });
  test('no legacy code is described as withdrawn in the table', () => {
    for (const code of LEGACY) assert.equal(TABLE.get(code)?.listStatus, 'legacy', code);
    assert.equal(CURRENCY_ENTRIES.some((e) => (e.listStatus as string) === 'withdrawn'), false);
  });
});

describe('funds and special-purpose codes stay out of ordinary pricing', () => {
  test('the official classification is preserved', () => {
    assert.equal(TABLE.get('UYW')?.classification, 'fund');
    assert.equal(TABLE.get('CLF')?.classification, 'fund');
    assert.equal(TABLE.get('XAU')?.classification, 'special');
    assert.equal(TABLE.get('XDR')?.classification, 'special');
    assert.equal(TABLE.get('XXX')?.classification, 'special');
  });
  test('they are refused for new and stored amounts, and have no exponent for pricing', () => {
    for (const code of ['UYW', 'CLF', 'CHE', 'USN', 'XAU', 'XAG', 'XDR', 'XXX', 'XTS']) {
      assert.equal(isCurrencyCode(code), false, code);
      assert.equal(isKnownCurrencyCode(code), false, code);
      assert.throws(() => historicalMoney(1, code), TypeError, code);
    }
  });
  test('the four owner-decided codes match the XML', () => {
    assert.equal(minorUnitExponent('IQD'), 3);
    assert.equal(minorUnitExponent('IRR'), 2);
    assert.equal(minorUnitExponent('MGA'), 2);
    assert.equal(minorUnitExponent('RWF'), 0);
  });
});
