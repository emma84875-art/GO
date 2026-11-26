// Phase 18.7, browser side: offers in any valid ISO 4217 currency are shown with their code, and offers the page
// drops for a money reason are counted, not lost.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createSearchSupplier, excludedFrom } from '../src/js/flight-client.js';
import { cardFor, buildResultCards } from '../src/js/flight-view.js';

const SEG = {
  origin: 'LOS', destination: 'LHR', carrier: 'BA', flightNumber: '75',
  departureUtc: '2026-12-01T07:00:00Z', arrivalUtc: '2026-12-01T13:00:00Z',
  departureTimeZone: 'Africa/Lagos', arrivalTimeZone: 'Europe/London',
};

function offer(id, currency, amountMinor) {
  return {
    id,
    supplierPrice: { amountMinor, currency },
    displayPrice: { amountMinor, currency },
    expiresAtUtc: '2026-11-30T12:00:00Z',
    segments: [SEG],
    journeys: [[SEG]],
    fare: null,
  };
}

function supplierWith(body, status = 200) {
  const fetchImpl = async () => ({ ok: status === 200, status, json: async () => body });
  return createSearchSupplier({ endpoint: 'https://search.example.test/api/flights/search', input: {}, fetchImpl });
}

describe('Phase 18.7: the page shows every valid currency with its code', () => {
  test('a JPY, KWD and NGN offer are each kept in their own currency', async () => {
    const supplier = supplierWith({
      status: 'ok',
      offers: [offer('jpy', 'JPY', 15000), offer('kwd', 'KWD', 12500), offer('ngn', 'NGN', 45000000)],
      excluded: { invalidCurrency: 0, currencies: [], invalidPrice: 0 },
    });
    const result = await supplier.searchDetailed();
    assert.deepEqual(result.offers.map((o) => o.displayPrice.currency), ['JPY', 'KWD', 'NGN']);
    assert.deepEqual(result.excluded, { invalidCurrency: 0, currencies: [], invalidPrice: 0, malformed: 0 });
  });

  test('the card shows the ISO code and the exact amount for each currency', () => {
    assert.equal(cardFor(offer('jpy', 'JPY', 15000), 'one_way', 'NGN').price, 'JPY 15,000');
    assert.equal(cardFor(offer('kwd', 'KWD', 12500), 'one_way', 'NGN').price, 'KWD 12.500');
    assert.equal(cardFor(offer('usd', 'USD', 45000), 'one_way', 'NGN').price, 'USD 450.00');
  });

  test('mixed currencies set the mixed-currency warning', () => {
    const cards = buildResultCards([offer('a', 'NGN', 100), offer('b', 'JPY', 100)], { sort: 'price' }, 'one_way', 'NGN');
    assert.equal(cards.mixedCurrencies, true);
  });
});

describe('Phase 18.7: offers the page drops are counted', () => {
  test('an offer in a currency the page cannot show is counted with its code', async () => {
    const bad = { ...offer('iqd', 'UYW', 100000), displayPrice: { amountMinor: 100000, currency: 'UYW' } };
    const supplier = supplierWith({ status: 'ok', offers: [offer('ngn', 'NGN', 100), bad], excluded: { invalidCurrency: 0, currencies: [], invalidPrice: 0 } });
    const result = await supplier.searchDetailed();
    assert.deepEqual(result.offers.map((o) => o.id), ['ngn']);
    assert.deepEqual(result.excluded, { invalidCurrency: 1, currencies: ['UYW'], invalidPrice: 0, malformed: 0 });
  });

  test('a zero price is counted as invalidPrice', async () => {
    const zero = offer('zero', 'NGN', 0);
    const supplier = supplierWith({ status: 'ok', offers: [zero], excluded: { invalidCurrency: 0, currencies: [], invalidPrice: 0 } });
    const result = await supplier.searchDetailed();
    assert.equal(result.offers.length, 0);
    assert.deepEqual(result.excluded, { invalidCurrency: 0, currencies: [], invalidPrice: 1, malformed: 0 });
  });

  test('the page counts are added to the service counts', async () => {
    const supplier = supplierWith({
      status: 'ok',
      offers: [offer('iqd', 'UYW', 5)].map((o) => ({ ...o, displayPrice: { amountMinor: 5, currency: 'UYW' } })),
      excluded: { invalidCurrency: 2, currencies: ['ZZQ'], invalidPrice: 1 },
    });
    const result = await supplier.searchDetailed();
    assert.deepEqual(result.excluded, { invalidCurrency: 3, currencies: ['UYW', 'ZZQ'], invalidPrice: 1, malformed: 0 });
  });

  test('when every offer is excluded for a money reason, the result is empty with counts', async () => {
    const supplier = supplierWith({
      status: 'ok',
      offers: [{ ...offer('x', 'UYW', 5), displayPrice: { amountMinor: 5, currency: 'UYW' } }],
      excluded: { invalidCurrency: 0, currencies: [], invalidPrice: 0 },
    });
    const result = await supplier.searchDetailed();
    assert.equal(result.offers.length, 0);
    assert.deepEqual(result.excluded.currencies, ['UYW']);
  });

  test('a structurally malformed offer is counted as malformed and does not break the valid offers', async () => {
    const supplier = supplierWith({ status: 'ok', offers: [offer('ngn', 'NGN', 100), { id: 'broken' }], excluded: { invalidCurrency: 0, currencies: [], invalidPrice: 0, malformed: 0 } });
    const result = await supplier.searchDetailed();
    assert.deepEqual(result.offers.map((o) => o.id), ['ngn']);
    assert.deepEqual(result.excluded, { invalidCurrency: 0, currencies: [], invalidPrice: 0, malformed: 1 });
  });

  test('a response that is not a list of offers is still an invalid response', async () => {
    const supplier = supplierWith({ status: 'ok', offers: 'nope', excluded: { invalidCurrency: 0, currencies: [], invalidPrice: 0, malformed: 0 } });
    await assert.rejects(() => supplier.searchDetailed(), (error) => error.reason === 'invalid_response');
  });
});

describe('Phase 18.7: excluded codes from the service are sanitised', () => {
  test('only three capital letters are kept as codes', () => {
    assert.deepEqual(excludedFrom({ invalidCurrency: 1, currencies: ['IQD', '<b>', 'ngn'], invalidPrice: 0, malformed: 0 }).currencies, ['IQD']);
  });
});

// Server and browser must agree on every code. The browser runs the vendored copy of the same module.
import * as serverMoney from '../../../packages/core/src/money.ts';
import * as browserMoney from '../src/vendor/packages/core/src/money.js';
import { CURRENCY_ENTRIES } from '../../../packages/core/src/currency-metadata.ts';
import { inputFromParams } from '../src/js/flight-logic.js';

describe('Phase 18.7 correction pass: server and browser agree', () => {
  test('every table code gets the same answer from the server copy and the browser copy', () => {
    const probes = [...CURRENCY_ENTRIES.map((entry) => entry.code), 'UYW', 'CLF', 'XDR', 'ngn', 'NG', '<b>'];
    for (const code of probes) {
      assert.equal(browserMoney.isCurrencyCode(code), serverMoney.isCurrencyCode(code), `isCurrencyCode ${code}`);
      assert.equal(browserMoney.isKnownCurrencyCode(code), serverMoney.isKnownCurrencyCode(code), `isKnownCurrencyCode ${code}`);
    }
    for (const entry of CURRENCY_ENTRIES.filter((e) => e.classification === 'currency')) {
      assert.equal(browserMoney.minorUnitExponent(entry.code), serverMoney.minorUnitExponent(entry.code), entry.code);
      assert.equal(
        browserMoney.formatMoney(browserMoney.historicalMoney(12345, entry.code)),
        serverMoney.formatMoney(serverMoney.historicalMoney(12345, entry.code)),
        entry.code,
      );
    }
  });

  test('the four owner-corrected exponents are the same on both sides', () => {
    for (const [code, exponent] of [['IQD', 3], ['IRR', 2], ['MGA', 2], ['RWF', 0]]) {
      assert.equal(browserMoney.minorUnitExponent(code), exponent);
      assert.equal(serverMoney.minorUnitExponent(code), exponent);
    }
  });

  test('the request always asks for NGN, so no currency can be chosen in the page', () => {
    assert.equal(inputFromParams({ trip: 'one_way', from: 'LOS', to: 'LHR', depart: '2026-12-01', currency: 'USD' }).displayCurrency, 'NGN');
    assert.equal(inputFromParams({ trip: 'one_way', from: 'LOS', to: 'LHR', depart: '2026-12-01' }).displayCurrency, 'NGN');
  });

  test('a legacy code from the supplier is excluded and counted in the browser too', async () => {
    const hrk = { ...offer('hrk', 'HRK', 100), displayPrice: { amountMinor: 100, currency: 'HRK' } };
    const supplier = supplierWith({ status: 'ok', offers: [hrk], excluded: { invalidCurrency: 0, currencies: [], invalidPrice: 0, malformed: 0 } });
    const result = await supplier.searchDetailed();
    assert.equal(result.offers.length, 0);
    assert.deepEqual(result.excluded, { invalidCurrency: 1, currencies: ['HRK'], invalidPrice: 0, malformed: 0 });
  });
});

describe('List One corrections in the browser', () => {
  test('a VED fare is shown with its own code and two decimals', () => {
    assert.equal(cardFor(offer('ved', 'VED', 123456), 'one_way', 'NGN').price, 'VED 1,234.56');
  });
  test('VED and VES cards are not mixed into one currency', () => {
    const cards = buildResultCards([offer('ved', 'VED', 100), offer('ves', 'VES', 100)], { sort: 'price' }, 'one_way', 'NGN');
    assert.equal(cards.mixedCurrencies, true);
    assert.deepEqual(cards.cards.map((c) => c.currencyCode).sort(), ['VED', 'VES']);
  });
  test('a legacy code from the supplier is excluded in the browser with its code', async () => {
    const ang = { ...offer('ang', 'ANG', 100), displayPrice: { amountMinor: 100, currency: 'ANG' } };
    const supplier = supplierWith({ status: 'ok', offers: [ang], excluded: { invalidCurrency: 0, currencies: [], invalidPrice: 0, malformed: 0 } });
    const result = await supplier.searchDetailed();
    assert.equal(result.offers.length, 0);
    assert.deepEqual(result.excluded.currencies, ['ANG']);
  });
});
