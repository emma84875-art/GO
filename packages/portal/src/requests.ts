// Customer requests: cancellation and support.
//
// A request is recorded for staff to act on. Nothing here cancels a booking with the supplier,
// issues a refund or changes a status. Cancellation with the supplier stays with the fulfilment
// orchestrator (cancelBooking), which is gated and reviewed by the owner.
//
// Which statuses allow a cancellation request mirrors cancelBooking in fulfilment/orchestrator.ts:
// a cancellation is only meaningful once a supplier order exists.

import type { FulfilmentStatus } from '../../fulfilment/src/status.ts';
import type { Actor } from './access.ts';
import { ownsBooking } from './access.ts';
import type { PortalBooking } from './model.ts';

export interface RequestDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

export interface CustomerRequest {
  readonly kind: 'cancellation' | 'support';
  readonly bookingId: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly message: string | null;
  readonly state: 'open';
}

export interface AuditDraft {
  readonly actorId: string;
  readonly action: 'booking.cancellation_requested' | 'booking.support_requested';
  readonly entityId: string;
  readonly at: string;
}

export type RequestResult =
  | { readonly ok: true; readonly request: CustomerRequest; readonly audit: AuditDraft }
  | { readonly ok: false; readonly reason: string };

export const SUPPORT_MESSAGE_MAX = 500;

// Statuses where a cancellation request can be raised, because a supplier order exists.
const CANCELLABLE: readonly FulfilmentStatus[] = ['order_pending', 'ticketing_pending', 'partially_fulfilled', 'ticketed', 'confirmed'];

const NOT_CANCELLABLE_REASON: Partial<Record<FulfilmentStatus, string>> = {
  held: 'Your booking is still being processed, so it cannot be cancelled here. Contact support if you need help.',
  authorised: 'Your booking is still being processed, so it cannot be cancelled here. Contact support if you need help.',
  order_unknown: 'We are checking this booking with the airline. Please wait for our update before asking for a cancellation.',
  ticketing_unknown: 'We are checking this booking with the airline. Please wait for our update before asking for a cancellation.',
  cancellation_pending: 'A cancellation is already in progress.',
  cancelled: 'This booking has already been cancelled.',
  refund_pending: 'This booking has been cancelled and a refund is in progress.',
  refunded: 'This booking has been cancelled and refunded.',
  failed: 'This booking was not completed, so there is nothing to cancel.',
  expired: 'This fare expired before the booking was completed, so there is nothing to cancel.',
};

// Whether the customer may ask for a cancellation of this booking right now. A request is not a
// cancellation, and fare rules still apply.
export function cancellationDecision(actor: Actor, booking: PortalBooking): RequestDecision {
  if (!ownsBooking(actor, booking.ownerUserId)) return { allowed: false, reason: 'Booking not found.' };
  const status = booking.record.status;
  if (CANCELLABLE.includes(status)) {
    return { allowed: true, reason: 'You can ask us to cancel this booking. Cancellation follows the fare rules, and refunds are not guaranteed.' };
  }
  return { allowed: false, reason: NOT_CANCELLABLE_REASON[status] ?? 'This booking cannot be cancelled here.' };
}

export function requestCancellation(actor: Actor, booking: PortalBooking, nowUtc: string): RequestResult {
  const decision = cancellationDecision(actor, booking);
  if (!decision.allowed) return { ok: false, reason: decision.reason };
  return {
    ok: true,
    request: { kind: 'cancellation', bookingId: booking.record.bookingId, requestedBy: actor.userId, requestedAt: nowUtc, message: null, state: 'open' },
    audit: { actorId: actor.userId, action: 'booking.cancellation_requested', entityId: booking.record.bookingId, at: nowUtc },
  };
}

// Support requests are allowed for the owner in any status. The message is plain text, trimmed,
// and limited in length.
export function requestSupport(actor: Actor, booking: PortalBooking, message: string, nowUtc: string): RequestResult {
  if (!ownsBooking(actor, booking.ownerUserId)) return { ok: false, reason: 'Booking not found.' };
  const text = message.trim();
  if (text.length === 0) return { ok: false, reason: 'Please describe what you need help with.' };
  if (text.length > SUPPORT_MESSAGE_MAX) return { ok: false, reason: `Please keep your message to ${SUPPORT_MESSAGE_MAX} characters.` };
  return {
    ok: true,
    request: { kind: 'support', bookingId: booking.record.bookingId, requestedBy: actor.userId, requestedAt: nowUtc, message: text, state: 'open' },
    audit: { actorId: actor.userId, action: 'booking.support_requested', entityId: booking.record.bookingId, at: nowUtc },
  };
}
