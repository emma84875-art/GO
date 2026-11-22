// Permissions for GO's people. These are the application checks. The database policies (RLS and the
// staff functions) enforce the same matrix independently; both must agree, and the tests cover both.
//
// Rules:
//   - Deny by default. A permission not in the matrix is refused, and an unknown permission name is a
//     programming error that throws rather than returning "allowed".
//   - Customers act only on their own bookings. Another customer's booking is reported as not found by
//     the caller, so this module returns a plain denial and never reveals that the booking exists.
//   - Every staff permission requires an MFA session (aal2) and a session that is still fresh.
//   - Customer MFA is optional, so no customer permission requires it.
//   - Role changes are not a customer or staff permission in the API. They go through the logged
//     administrator path on the server, which uses the service role after checking this matrix.

import { AccessDenied } from './actor.ts';
import type { Actor, Role } from './actor.ts';

export const PERMISSIONS = [
  'booking.read.own',
  'booking.read.all',
  'passenger.read.assigned',
  'booking.cancel.staff',
  'refund.issue',
  'assignment.manage',
  'audit.read',
  'role.change',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

// The permission matrix. Each role lists the permissions it holds. Anything missing is denied.
const MATRIX: Readonly<Record<Role, readonly Permission[]>> = {
  customer: ['booking.read.own'],
  // Support: reads all bookings, passenger details only for assigned bookings, cancels with the supplier.
  support: ['booking.read.all', 'passenger.read.assigned', 'booking.cancel.staff'],
  // Operations: watches bookings, payments and tickets. Never passenger details, never money actions.
  operations: ['booking.read.all'],
  // Administrators: everything support has, plus refunds, assignments, audit and logged role changes.
  admin: [
    'booking.read.all',
    'passenger.read.assigned',
    'booking.cancel.staff',
    'refund.issue',
    'assignment.manage',
    'audit.read',
    'role.change',
  ],
};

const STAFF_ROLES: readonly Role[] = ['support', 'operations', 'admin'];

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

// Pure decision. Returns null if allowed, or the reason for denial.
export function denialReason(actor: Actor | null, permission: Permission, ownerUserId?: string): string | null {
  if (actor === null) return 'not signed in';
  if (!isPermission(permission)) throw new TypeError(`unknown permission: ${String(permission)}`);
  if (actor.kind === 'system') return 'system actors do not hold user permissions';

  const granted = Object.hasOwn(MATRIX, actor.role) && MATRIX[actor.role].includes(permission);
  if (!granted) return `role ${actor.role} does not hold ${permission}`;

  if (permission === 'booking.read.own') {
    if (ownerUserId === undefined || ownerUserId !== actor.userId) return 'not the owner';
    return null;
  }

  if (STAFF_ROLES.includes(actor.role) && !actor.mfa) {
    return 'staff permissions require a multi-factor session';
  }
  return null;
}

// Throws AccessDenied with a fixed message. Callers map it to a generic response.
export function requirePermission(actor: Actor | null, permission: Permission, ownerUserId?: string): void {
  const reason = denialReason(actor, permission, ownerUserId);
  if (reason !== null) throw new AccessDenied(permission, reason);
}

export function permissionsFor(role: Role): readonly Permission[] {
  if (!Object.hasOwn(MATRIX, role)) return [];
  return MATRIX[role];
}
