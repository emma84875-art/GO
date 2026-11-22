// Actor: who is performing an operation. Every money-moving function takes an Actor and calls
// authorise() before doing anything.
//
// Rules:
//   - An Actor is built only from a verified source: a verified access token (token.ts) or a
//     trusted internal service. Never from a request body, a query string or a client header.
//   - Deny by default. An action is allowed only if the table below names it for that actor.
//   - Staff actions require a multi-factor session (aal2). Customers act only on their own bookings.

export type Role = 'customer' | 'support' | 'operations' | 'admin';

export type ServiceName = 'payments' | 'fulfilment' | 'worker';

export type Actor =
  | { readonly kind: 'user'; readonly userId: string; readonly role: Role; readonly mfa: boolean }
  | { readonly kind: 'system'; readonly service: ServiceName };

export type MoneyAction =
  | 'payment.start'
  | 'payment.capture'
  | 'payment.release'
  | 'payment.refund'
  | 'fulfilment.order'
  | 'fulfilment.poll'
  | 'fulfilment.cancel';

// Services allowed for each action. Anything not listed is denied.
const SERVICES: Readonly<Record<MoneyAction, readonly ServiceName[]>> = {
  'payment.start': ['payments'],
  'payment.capture': ['fulfilment'],
  'payment.release': ['fulfilment', 'payments'],
  'payment.refund': ['payments', 'fulfilment'], // fulfilment reaches it only through cancelBooking
  'fulfilment.order': ['fulfilment'],
  'fulfilment.poll': ['fulfilment', 'worker'],
  'fulfilment.cancel': ['fulfilment'],
};

// Staff roles allowed to act through an MFA session. Customers are never allowed these actions.
const STAFF_WITH_MFA: Readonly<Partial<Record<MoneyAction, readonly Role[]>>> = {
  'fulfilment.cancel': ['support', 'admin'],
  'payment.refund': ['admin'],
};

export class AccessDenied extends Error {
  readonly code = 'access_denied';
  readonly action: string;

  constructor(action: string, reason: string) {
    super(`Access denied for ${action}: ${reason}`);
    this.name = 'AccessDenied';
    this.action = action;
  }
}

// Stable label for the audit log. It never contains a token or an email address.
export function actorLabel(actor: Actor): string {
  return actor.kind === 'system' ? `system:${actor.service}` : `user:${actor.userId}`;
}

export function authorise(actor: Actor, action: MoneyAction, ownerUserId?: string): void {
  if (actor.kind === 'system') {
    if (SERVICES[action].includes(actor.service)) return;
    throw new AccessDenied(action, `service ${actor.service} is not permitted`);
  }

  if (action === 'payment.start') {
    if (actor.role === 'customer' && ownerUserId !== undefined && actor.userId === ownerUserId) return;
    throw new AccessDenied(action, 'only the booking owner may start a payment');
  }

  const staffRoles = STAFF_WITH_MFA[action];
  if (staffRoles && staffRoles.includes(actor.role)) {
    if (actor.mfa) return;
    throw new AccessDenied(action, 'staff actions require a multi-factor session');
  }
  throw new AccessDenied(action, `role ${actor.role} is not permitted`);
}
