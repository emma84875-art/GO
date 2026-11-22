// Notification preferences.
//
// Only optional updates can be switched off: booking progress (intermediate status changes) and
// support replies. Everything else is required for the account to work safely: account
// verification, password reset, security alerts, final booking status, payment, tickets,
// itinerary, cancellation and refund outcomes. Those messages cannot be turned off, so a
// preference can never hide a payment result or a security alert.
//
// There is no marketing email. No send path exists for it, so there is no marketing preference.

import type { NotificationRequest, PreferenceKey } from './requests.ts';

export interface Preferences {
  readonly bookingProgress: boolean;
  readonly supportReplies: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = Object.freeze({ bookingProgress: true, supportReplies: true });

export function preferenceAllows(request: NotificationRequest, prefs: Preferences): { readonly allowed: boolean; readonly reason: string | null } {
  const key: PreferenceKey | null = request.preferenceKey;
  if (key === null) return { allowed: true, reason: null };
  return prefs[key] ? { allowed: true, reason: null } : { allowed: false, reason: `preference_${key}_off` };
}

// Returns the preferences with only known keys set. Unknown or non-boolean values fall back to
// the default. This protects against a stored value that was edited by hand.
export function sanitisePreferences(raw: unknown): Preferences {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_PREFERENCES;
  const r = raw as Record<string, unknown>;
  return Object.freeze({
    bookingProgress: typeof r.bookingProgress === 'boolean' ? r.bookingProgress : DEFAULT_PREFERENCES.bookingProgress,
    supportReplies: typeof r.supportReplies === 'boolean' ? r.supportReplies : DEFAULT_PREFERENCES.supportReplies,
  });
}
