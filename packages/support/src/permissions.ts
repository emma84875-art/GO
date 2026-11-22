// Permissions for support, cancellation and refund actions.
//
// Roles come from portal/src/access.ts (customer, support, admin). A permission is granted to a
// role here; ownership checks (a customer may act only on their own bookings) are made by the
// service, which also records every allowed and denied attempt in the audit log.
//
// Separation of duties for refunds:
//   - Support staff may check eligibility. They cannot approve.
//   - Only an admin may approve or reject, and never a refund they requested themselves.
//   - Only an admin may execute, and execution is behind a gate that is off by default.

import { AccessDeniedError, type Actor, type AppRole } from '../../portal/src/access.ts';

export type Permission =
  | 'support.create'
  | 'support.read_own'
  | 'support.reply_own'
  | 'support.read_all'
  | 'support.reply_staff'
  | 'support.internal_note'
  | 'support.triage'
  | 'support.assign'
  | 'cancellation.request'
  | 'cancellation.review'
  | 'cancellation.execute'
  | 'refund.request'
  | 'refund.check_eligibility'
  | 'refund.approve'
  | 'refund.execute'
  | 'audit.read';

const CUSTOMER: readonly Permission[] = ['support.create', 'support.read_own', 'support.reply_own', 'cancellation.request', 'refund.request'];

const SUPPORT: readonly Permission[] = [
  'support.read_all',
  'support.reply_staff',
  'support.internal_note',
  'support.triage',
  'support.assign',
  'cancellation.review',
  'refund.check_eligibility',
];

const ADMIN: readonly Permission[] = [
  ...SUPPORT,
  'cancellation.execute',
  'refund.approve',
  'refund.execute',
  'audit.read',
];

const GRANTS: Readonly<Record<AppRole, ReadonlySet<Permission>>> = {
  customer: new Set(CUSTOMER),
  support: new Set(SUPPORT),
  admin: new Set(ADMIN),
};

export function can(actor: Actor, permission: Permission): boolean {
  return GRANTS[actor.role].has(permission);
}

export function requirePermission(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) {
    throw new AccessDeniedError(`Role ${actor.role} may not ${permission}.`);
  }
}

export function permissionsFor(role: AppRole): readonly Permission[] {
  return [...GRANTS[role]].sort();
}
