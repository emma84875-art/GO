// Hold expiry. A hold reserves seats only until its expiry time. Times are UTC ISO.
// The state is recomputed from the clock on every read, never cached.

export type ExpiryState = 'active' | 'expiring_soon' | 'expired';

export function holdExpiryState(expiresAtUtc: string, nowUtc: string, warnMinutes = 10): ExpiryState {
  const remainingMs = Date.parse(expiresAtUtc) - Date.parse(nowUtc);
  if (Number.isNaN(remainingMs)) throw new RangeError('Expiry and current time must be valid ISO timestamps');
  if (remainingMs <= 0) return 'expired';
  if (remainingMs <= warnMinutes * 60_000) return 'expiring_soon';
  return 'active';
}

export function minutesRemaining(expiresAtUtc: string, nowUtc: string): number {
  return Math.max(0, Math.floor((Date.parse(expiresAtUtc) - Date.parse(nowUtc)) / 60_000));
}
