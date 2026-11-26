// Money is always an integer count of minor units together with an ISO 4217 currency code. Floats are never
// used for amounts, and the text shown to a customer is built from the integer by string operations, so no
// rounding can change it.
//
// Currency rules come from the shared table in currency-metadata.ts, which is generated from the SIX ISO 4217
// List One XML, so the server and the browser always agree. Symbols are never used: every amount is shown with
// its code. Funds and special-purpose codes are never ordinary currencies, so they are refused everywhere.
//
//   money()            new amounts: an ordinary currency (classification 'currency') with listStatus 'current'.
//   historicalMoney()  stored records: any ordinary currency, including legacy codes such as HRK, so they still display.
//   formatMoney()      formats any ordinary currency in the table, so historical amounts display correctly.

import { CURRENCY_ENTRIES, type CurrencyEntry } from './currency-metadata.ts';

export type CurrencyCode = string; // three capital letters, checked against the table

const CODE_SHAPE = /^[A-Z]{3}$/;
const BY_CODE: ReadonlyMap<string, CurrencyEntry> = new Map(CURRENCY_ENTRIES.map((entry) => [entry.code, entry]));

function entryOf(value: unknown): CurrencyEntry | undefined {
  return typeof value === 'string' && CODE_SHAPE.test(value) ? BY_CODE.get(value) : undefined;
}

// True for a code that may be used for a new amount: an ordinary currency that is current in List One.
export function isCurrencyCode(value: unknown): value is CurrencyCode {
  const entry = entryOf(value);
  return entry?.classification === 'currency' && entry.listStatus === 'current';
}

// True for an ordinary currency in any list status, including legacy codes. Used for stored records only.
// Funds and special-purpose codes are not currencies and return false.
export function isKnownCurrencyCode(value: unknown): value is CurrencyCode {
  return entryOf(value)?.classification === 'currency';
}

// The number of decimal places in the currency's minor unit (JPY 0, NGN 2, KWD 3). Throws for a code that is not
// an ordinary currency in the table.
export function minorUnitExponent(currency: CurrencyCode): number {
  const entry = entryOf(currency);
  if (entry?.classification !== 'currency' || entry.exponent === null) {
    throw new TypeError(`Not an ordinary currency code: ${String(currency).slice(0, 8)}`);
  }
  return entry.exponent;
}

export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

function assertSafeAmount(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new TypeError(`Money amount must be a safe integer of minor units, got ${amountMinor}`);
  }
}

// A new amount. Legacy, fund, special and unlisted codes are refused.
export function money(amountMinor: number, currency: CurrencyCode): Money {
  assertSafeAmount(amountMinor);
  if (!isCurrencyCode(currency)) {
    throw new TypeError(`Unsupported currency code: ${String(currency).slice(0, 8)}`);
  }
  return { amountMinor, currency };
}

// A stored amount. Any ordinary currency in the table is accepted, including legacy codes.
export function historicalMoney(amountMinor: number, currency: CurrencyCode): Money {
  assertSafeAmount(amountMinor);
  if (!isKnownCurrencyCode(currency)) {
    throw new TypeError(`Not an ordinary currency code: ${String(currency).slice(0, 8)}`);
  }
  return { amountMinor, currency };
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function sumMoney(values: readonly Money[], currency: CurrencyCode): Money {
  return values.reduce<Money>((total, value) => addMoney(total, value), money(0, currency));
}

// Digits with the decimal point inserted, using only string operations. Exact for every safe integer.
export function formatAmountDigits(amountMinor: number, exponent: number): string {
  const sign = amountMinor < 0 ? '-' : '';
  const digits = String(Math.abs(amountMinor)).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (exponent === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${digits.slice(digits.length - exponent)}`;
}

// The amount with its ISO code, for example "NGN 450,000.00", "JPY 15,000" or "KWD 12.500".
// The second argument is accepted for compatibility and ignored: no locale-based symbol is used.
export function formatMoney(value: Money, _locale?: string): string {
  return `${value.currency} ${formatAmountDigits(value.amountMinor, minorUnitExponent(value.currency))}`;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`Cannot combine ${a.currency} with ${b.currency} without an explicit FX conversion`);
  }
}
