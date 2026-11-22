// Staff MFA reset decisions, as the server checks them before it calls the database functions.
//
// The database is the authority (supabase/migrations/20261122150000_super_admin_mfa_reset.sql). This
// module runs the same rules first so that the server can refuse early and explain why, and the
// tests check that both sides agree on each case.
//
// Process, each step audited:
//   1. request   - a super administrator in an MFA session, with a documented reason (20-1000 characters).
//   2. verify    - a DIFFERENT super administrator records the identity check (method only, no ID data).
//   3. notify    - the server tells the affected staff member, out of band, before any factor is removed.
//   4. remove    - the server removes the target's factors through the Supabase Admin API (service role).
//   5. complete  - a third super administrator (not the requester) records completion.
// A super administrator cannot reset their own factor, cannot be the target, and cannot be the requester
// who completes. At least two active super administrators must remain at all times.

export const REASON_MIN_CHARACTERS = 20;
export const REASON_MAX_CHARACTERS = 1000;
export const MIN_ACTIVE_SUPER_ADMINS = 2;

export const IDENTITY_METHODS = ['in_person', 'video_call_with_photo_id', 'callback_to_registered_number'] as const;
export type IdentityMethod = (typeof IDENTITY_METHODS)[number];

export type ResetRecord = {
  readonly requestedBy: string;
  readonly targetUserId: string;
  readonly identityVerifiedBy: string | null;
  readonly identityVerifiedAt: string | null;
  readonly targetNotifiedAt: string | null;
  readonly completedBy: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
};

export type ResetAction = 'verify' | 'complete' | 'cancel';

export type Decision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

const ALLOW: Decision = { allowed: true };
const deny = (reason: string): Decision => ({ allowed: false, reason });

export function validateReason(reason: string): Decision {
  if (typeof reason !== 'string') return deny('reason must be text');
  const length = [...reason.trim()].length;
  if (length < REASON_MIN_CHARACTERS) return deny(`reason must be at least ${REASON_MIN_CHARACTERS} characters`);
  if (length > REASON_MAX_CHARACTERS) return deny(`reason must be at most ${REASON_MAX_CHARACTERS} characters`);
  return ALLOW;
}

export function resetStatus(record: ResetRecord): 'open' | 'completed' | 'cancelled' {
  if (record.completedAt !== null) return 'completed';
  if (record.cancelledAt !== null) return 'cancelled';
  return 'open';
}

// Whether a super administrator (in an MFA session) may take the action on this reset.
export function decideResetAction(
  record: ResetRecord,
  action: ResetAction,
  actorId: string,
  actorIsSuperAdminMfa: boolean,
): Decision {
  if (!actorIsSuperAdminMfa) return deny('only a super administrator in a multi-factor session may act on a reset');
  if (resetStatus(record) !== 'open') return deny('this reset is closed');

  if (action === 'verify') {
    if (actorId === record.requestedBy) return deny('the requesting super administrator cannot verify the identity');
    if (record.identityVerifiedAt !== null) return deny('the identity check is already recorded');
    return ALLOW;
  }
  if (action === 'complete') {
    if (actorId === record.requestedBy) return deny('the requesting super administrator cannot complete the reset');
    if (record.identityVerifiedAt === null) return deny('the identity check has not been recorded');
    if (record.targetNotifiedAt === null) return deny('the affected staff member must be notified first');
    return ALLOW;
  }
  return ALLOW; // cancel: any active super administrator, while the reset is open
}

// Whether a request may target this account. The caller must already be a super administrator.
export function decideRequest(
  requesterId: string,
  targetId: string,
  targetIsStaff: boolean,
  targetIsSuperAdmin: boolean,
): Decision {
  if (requesterId === targetId) return deny('a super administrator cannot reset their own multi-factor method');
  if (targetIsSuperAdmin) return deny('a super administrator account is recovered through the separate procedure');
  if (!targetIsStaff) return deny('the target account is not a staff account');
  return ALLOW;
}

// Whether revoking one super administrator keeps the minimum number in place.
export function decideRevocation(activeSuperAdminCount: number): Decision {
  if (activeSuperAdminCount - 1 < MIN_ACTIVE_SUPER_ADMINS) {
    return deny(`at least ${MIN_ACTIVE_SUPER_ADMINS} active super administrators must remain`);
  }
  return ALLOW;
}
