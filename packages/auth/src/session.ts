// Request authentication: from a bearer token to an Actor, or a refusal.
//
// Order, and every step can end the request:
//   1. The bearer token must be present and must verify (token.ts). Expiry and not-yet-valid times are
//      checked there.
//   2. The role is read from the database for the verified subject. A token claim cannot set a role.
//   3. A staff account must have a verified multi-factor method. Otherwise it is refused, even with a
//      valid token, so a staff member who removes their second factor loses staff access at once.
//   4. The actor is built. Its MFA flag is true only for an aal2 session that is still fresh.
//
// Refusals carry a fixed reason from a closed list. Callers must not send the reason to the client.

import type { Actor, Role } from './actor.ts';
import { actorFromVerifiedClaims, verifyAccessToken } from './token.ts';
import type { ActorPolicy, TokenConfig } from './token.ts';

export type AuthLookups = {
  // The role from the profiles table, or null if the account has no profile.
  readonly roleFor: (userId: string) => Promise<Role | null>;
  // Whether the account has at least one verified multi-factor method.
  readonly hasVerifiedMfa: (userId: string) => Promise<boolean>;
};

export const AUTH_FAILURES = [
  'no_token',
  'invalid_token',
  'unknown_account',
  'staff_mfa_not_enrolled',
] as const;
export type AuthFailure = (typeof AUTH_FAILURES)[number];

export type AuthOutcome = { readonly ok: true; readonly actor: Actor } | { readonly ok: false; readonly reason: AuthFailure };

const BEARER = 'Bearer ';

export async function authenticateRequest(
  bearerToken: string | undefined,
  config: TokenConfig,
  policy: ActorPolicy,
  lookups: AuthLookups,
  nowUtc: string,
): Promise<AuthOutcome> {
  if (bearerToken === undefined || bearerToken.length === 0) return { ok: false, reason: 'no_token' };

  const verified = verifyAccessToken(bearerToken, config, nowUtc);
  if (!verified.ok) return { ok: false, reason: 'invalid_token' };

  const role = await lookups.roleFor(verified.claims.sub);
  if (role === null) return { ok: false, reason: 'unknown_account' };

  if (role !== 'customer') {
    const enrolled = await lookups.hasVerifiedMfa(verified.claims.sub);
    if (!enrolled) return { ok: false, reason: 'staff_mfa_not_enrolled' };
  }

  const actor = actorFromVerifiedClaims(verified.claims, role, nowUtc, policy);
  if (actor === null) return { ok: false, reason: 'unknown_account' };
  return { ok: true, actor };
}

// Reads the bearer token from an Authorization header value. Returns undefined for any other form.
export function bearerFromHeader(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith(BEARER)) return undefined;
  const token = header.slice(BEARER.length);
  return token.length > 0 && !/\s/.test(token) ? token : undefined;
}
