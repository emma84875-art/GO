// Money is always stored as an integer count of minor units (kobo, cents, pence)
// together with an explicit currency code. Floats are never used for amounts.

export type CurrencyCode = 'NGN' | 'USD' | 'GBP' | 'EUR';

// ISO 4217 minor-unit exponents for the currencies we support.
const MINOR_UNIT_EXPONENT: Record<CurrencyCode, number> = {
  NGN: 2,
  USD: 2,
  GBP: 2,
  EUR: 2,
};

export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(MINOR_UNIT_EXPONENT, value);
}

export function minorUnitExponent(currency: CurrencyCode): number {
  return MINOR_UNIT_EXPONENT[currency];
}

export function money(amountMinor: number, currency: CurrencyCode): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new TypeError(`Money amount must be a safe integer of minor units, got ${amountMinor}`);
  }
  if (!isCurrencyCode(currency)) {
    throw new TypeError(`Unsupported currency: ${currency}`);
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

export function formatMoney(value: Money, locale = 'en-NG'): string {
  const exponent = minorUnitExponent(value.currency);
  const major = value.amountMinor / 10 ** exponent;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(major);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`Cannot combine ${a.currency} with ${b.currency} without an explicit FX conversion`);
  }
}
