// Role-based access for the customer dashboard and the operations dashboard.
//
// Database row level security (supabase/migrations/*.sql) is the enforcement layer. These
// checks mirror it in server code so a view is never built with data the role may not see.
// Roles match profiles.role: customer, support, admin.
//
// Rules:
//   - A customer sees only bookings they own. A booking they do not own is reported as not found,
//     not as forbidden, so the existence of other bookings is not revealed.
//   - Staff (support, admin) can open the operations dashboard and see passenger detail
//     (date of birth, nationality), as privacy.ts allows for support.
//   - Nobody's role can be changed through these views.

export type AppRole = 'customer' | 'support' | 'admin';

export interface Actor {
  readonly userId: string;
  readonly role: AppRole;
}

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

export function isStaff(actor: Actor): boolean {
  return actor.role === 'support' || actor.role === 'admin';
}

export function ownsBooking(actor: Actor, ownerUserId: string): boolean {
  return actor.userId === ownerUserId;
}

export function canOpenOperations(actor: Actor): boolean {
  return isStaff(actor);
}

export function requireOperations(actor: Actor): void {
  if (!canOpenOperations(actor)) throw new AccessDeniedError('Operations access requires a staff role.');
}
