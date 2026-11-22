// Account protections that GO applies on its own side of Supabase Auth: login throttling, password
// rules checked before a password is sent, and the fixed messages customers and staff see.
//
// Rules:
//   - Login attempts are counted per client address and per account. The account key is a hash of the
//     normalised email, so the raw address is not kept in memory.
//   - The same messages are returned whether or not an account exists, so the login and recovery
//     screens cannot be used to find out which emails are registered.
//   - Limits are in process memory. This matches the HTTP limiter and holds only for one instance.
//     Supabase's own auth rate limits also apply and are configured in the dashboard (see doc 20).

import { createHash } from 'node:crypto';

import { FixedWindowLimiter } from '../../http/src/rate-limit.ts';

export type WindowLimit = { readonly limit: number; readonly windowSeconds: number };

export type LoginLimits = {
  readonly perAddress: WindowLimit;
  readonly perAccount: WindowLimit;
};

export const DEFAULT_LOGIN_LIMITS: LoginLimits = {
  perAddress: { limit: 30, windowSeconds: 15 * 60 },
  perAccount: { limit: 5, windowSeconds: 15 * 60 },
};

export type LoginDecision = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

function accountKey(email: string): string {
  const normalised = email.trim().toLowerCase();
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}

export class LoginGuard {
  readonly #byAddress: FixedWindowLimiter;
  readonly #byAccount: FixedWindowLimiter;

  constructor(limits: LoginLimits = DEFAULT_LOGIN_LIMITS, now?: () => number) {
    this.#byAddress = new FixedWindowLimiter(limits.perAddress, now);
    this.#byAccount = new FixedWindowLimiter(limits.perAccount, now);
  }

  // Counts one attempt. Every attempt counts, successful or not, so a correct guess does not reset a
  // bad run.
  attempt(clientAddress: string, email: string): LoginDecision {
    if (typeof clientAddress !== 'string' || clientAddress.length === 0) {
      throw new TypeError('clientAddress must be a non-empty string');
    }
    if (typeof email !== 'string') throw new TypeError('email must be a string');

    const address = this.#byAddress.check(`addr:${clientAddress}`);
    if (!address.allowed) return { allowed: false, retryAfterSeconds: address.retryAfterSeconds };

    const account = this.#byAccount.check(`acct:${accountKey(email)}`);
    if (!account.allowed) return { allowed: false, retryAfterSeconds: account.retryAfterSeconds };

    return { allowed: true };
  }
}

// Password rules checked before a password is sent to Supabase. They must match the dashboard setting
// (minimum 12 characters). The maximum is 72 bytes, the limit of the bcrypt hash that Supabase uses.
export const PASSWORD_MIN_CHARACTERS = 12;
export const PASSWORD_MAX_BYTES = 72;

export type PasswordIssue = 'too_short' | 'too_long' | 'blank' | 'contains_email_name';

export function passwordIssues(password: string, email: string): readonly PasswordIssue[] {
  const issues: PasswordIssue[] = [];
  if (password.trim().length === 0) return ['blank'];
  if ([...password].length < PASSWORD_MIN_CHARACTERS) issues.push('too_short');
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) issues.push('too_long');

  // Compare letters and digits only, so "ada.lovelace" also catches "Ada-Lovelace-2026".
  const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const localPart = squash(email.split('@')[0] ?? '');
  if (localPart.length >= 3 && squash(password).includes(localPart)) issues.push('contains_email_name');
  return issues;
}

// The only messages shown to people for authentication outcomes.
export const PUBLIC_MESSAGES = {
  loginFailed: 'Email or password is incorrect.',
  loginThrottled: 'Too many attempts. Wait a few minutes and try again.',
  recoveryRequested: 'If an account exists for that email, we have sent a reset link.',
  verificationSent: 'Check your email for a confirmation link.',
  mfaFailed: 'That code is not valid. Try again.',
  staffMfaRequired: 'Staff accounts need a second sign-in step before they can open this page.',
  generic: 'Something went wrong. Please try again.',
} as const;
export type PublicMessageKey = keyof typeof PUBLIC_MESSAGES;

// Maps any internal failure to a public message. Internal reasons (token, role, signature, expiry)
// are never returned.
export function publicMessageFor(internal: string): string {
  switch (internal) {
    case 'bad_credentials':
    case 'unknown_account':
      return PUBLIC_MESSAGES.loginFailed;
    case 'throttled':
      return PUBLIC_MESSAGES.loginThrottled;
    case 'staff_mfa_not_enrolled':
      return PUBLIC_MESSAGES.staffMfaRequired;
    case 'mfa_failed':
      return PUBLIC_MESSAGES.mfaFailed;
    default:
      return PUBLIC_MESSAGES.generic;
  }
}
