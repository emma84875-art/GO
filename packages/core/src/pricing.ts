// Customer price breakdown. All arithmetic is exact integer arithmetic (BigInt),
// so no floating point rounding can change a customer's total.
//
// Rules:
//  - FX rates are snapshots scaled by 10^8 (matches numeric(18,8) in the database).
//  - Conversion and fee rounding is half-up on minor units.
//  - Fees are basis points of the converted base amount, plus an optional fixed fee.
//  - Supplier price is the cost to us; customer total is what the customer pays.

import type { CurrencyCode, Money } from './money.ts';
import { money, minorUnitExponent } from './money.ts';

export const FX_SCALE = 100_000_000n; // 10^8

export interface FxRateSnapshot {
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  readonly rateScaled: bigint; // 1 unit of `from` = rateScaled / 10^8 units of `to`, in minor-unit terms
  readonly capturedAtUtc: string;
}

export interface FeePolicy {
  readonly serviceFeeBasisPoints: number; // 100 bp = 1%
  readonly fixedFeeMinor: number; // in the display currency's minor units
}

export interface PriceBreakdown {
  readonly supplierCost: Money;
  readonly convertedBase: Money;
  readonly serviceFee: Money;
  readonly customerTotal: Money;
  readonly fxRate: FxRateSnapshot;
}

// Divides and rounds half-up for non-negative numerators.
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('Denominator must be positive');
  if (numerator < 0n) throw new RangeError('Negative amounts are not supported');
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export function convertMoney(amount: Money, snapshot: FxRateSnapshot): Money {
  if (amount.currency !== snapshot.from) {
    throw new TypeError(`Rate snapshot is for ${snapshot.from}, amount is ${amount.currency}`);
  }
  if (snapshot.rateScaled <= 0n) throw new RangeError('FX rate must be positive');
  // Both currencies are supported with 2 minor-unit digits, so no exponent adjustment is needed.
  // The function still checks it, so a future currency with a different exponent fails loudly.
  if (minorUnitExponent(amount.currency) !== minorUnitExponent(snapshot.to)) {
    throw new RangeError('Exponent conversion is not implemented for these currencies');
  }
  const converted = divRoundHalfUp(BigInt(amount.amountMinor) * snapshot.rateScaled, FX_SCALE);
  return money(Number(converted), snapshot.to);
}

export function applyFees(base: Money, policy: FeePolicy): { fee: Money; total: Money } {
  if (!Number.isInteger(policy.serviceFeeBasisPoints) || policy.serviceFeeBasisPoints < 0) {
    throw new RangeError('Service fee must be a non-negative whole number of basis points');
  }
  if (!Number.isSafeInteger(policy.fixedFeeMinor) || policy.fixedFeeMinor < 0) {
    throw new RangeError('Fixed fee must be a non-negative integer of minor units');
  }
  const percentage = divRoundHalfUp(BigInt(base.amountMinor) * BigInt(policy.serviceFeeBasisPoints), 10_000n);
  const feeMinor = Number(percentage) + policy.fixedFeeMinor;
  const fee = money(feeMinor, base.currency);
  const total = money(base.amountMinor + fee.amountMinor, base.currency);
  return { fee, total };
}

export function priceBreakdown(supplierCost: Money, snapshot: FxRateSnapshot, policy: FeePolicy): PriceBreakdown {
  const convertedBase = convertMoney(supplierCost, snapshot);
  const { fee, total } = applyFees(convertedBase, policy);
  return {
    supplierCost,
    convertedBase,
    serviceFee: fee,
    customerTotal: total,
    fxRate: snapshot,
  };
}
