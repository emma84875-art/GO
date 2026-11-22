// Notification requests: the typed, safe description of a message that other modules ask for.
//
// A request carries only what the template needs (booking reference, status wording, a nonce for
// authentication links). It never carries an email address, a link with a token, passenger data
// or ticket numbers. Builders return {ok:false} when the verified state does not support the
// message, so an unverified message cannot be queued.

import { formatLocal } from './render.ts';
import type { TemplateDataMap, TemplateId, Itinerary } from './templates.ts';
import { ticketsVerified, paymentCaptured, paymentFailed, type Verdict } from './verified.ts';
import type { FulfilmentRecord } from '../../fulfilment/src/store.ts';
import { customerStatus, type FulfilmentStatus } from '../../fulfilment/src/status.ts';
import type { PaymentStatus } from '../../payments/src/state.ts';
import { customerRefundWording, type Eligibility, type RefundStatus } from '../../support/src/refunds.ts';

export const CATEGORIES = ['account', 'security', 'booking', 'payment', 'ticketing', 'refunds', 'support'] as const;
export type Category = (typeof CATEGORIES)[number];

// Optional messages are the only ones a customer can switch off. Each has one preference key.
export type PreferenceKey = 'supportReplies' | 'bookingProgress';

export interface NotificationRequest {
  readonly template: TemplateId;
  readonly category: Category;
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly preferenceKey: PreferenceKey | null;
  readonly data: Record<string, unknown>;
  readonly createdAt: string;
}

export type BuildResult = { readonly ok: true; readonly request: NotificationRequest } | { readonly ok: false; readonly reason: string };

function build(
  template: TemplateId,
  category: Category,
  userId: string,
  key: string,
  preferenceKey: PreferenceKey | null,
  data: Record<string, unknown>,
  nowUtc: string,
): BuildResult {
  if (!userId.trim()) return { ok: false, reason: 'user_required' };
  if (!/^[A-Za-z0-9:_.-]{1,160}$/.test(key)) return { ok: false, reason: 'invalid_key' };
  return { ok: true, request: { template, category, userId, idempotencyKey: key, preferenceKey, data, createdAt: nowUtc } };
}

function fromVerdict(v: Verdict, then: () => BuildResult): BuildResult {
  return v.ok ? then() : { ok: false, reason: v.reason };
}

// --- account and security (always sent; no preference) -----------------------------------------

export function authRequest(kind: 'verify' | 'reset', userId: string, nonce: string, nowUtc: string): BuildResult {
  const template: TemplateId = kind === 'verify' ? 'account_verification' : 'password_reset';
  const data: TemplateDataMap['account_verification'] = { nonce, expiresInMinutes: 30 };
  return build(template, 'account', userId, `${template}:${nonce}`, null, { ...data }, nowUtc);
}

export function securityAlertRequest(userId: string, event: TemplateDataMap['security_alert']['event'], alertId: string, occurredAtUtc: string, nowUtc: string): BuildResult {
  return build('security_alert', 'security', userId, `security_alert:${alertId}`, null, { event, occurredAtUtc }, nowUtc);
}

// --- booking ----------------------------------------------------------------------------------

const INTERMEDIATE: readonly FulfilmentStatus[] = ['held', 'authorised', 'order_pending', 'ticketing_pending'];

export function bookingReceivedRequest(record: FulfilmentRecord, userId: string, nowUtc: string): BuildResult {
  return build('booking_received', 'booking', userId, `booking_received:${record.bookingId}`, null, { bookingReference: record.bookingReference }, nowUtc);
}

// Intermediate statuses are optional updates; final ones are always sent.
export function bookingStatusRequest(record: FulfilmentRecord, userId: string, nowUtc: string): BuildResult {
  const view = customerStatus(record.status);
  const optional = INTERMEDIATE.includes(record.status);
  return build(
    'booking_status',
    'booking',
    userId,
    `booking_status:${record.bookingId}:${record.status}`,
    optional ? 'bookingProgress' : null,
    { bookingReference: record.bookingReference, headline: view.headline, detail: view.detail },
    nowUtc,
  );
}

// --- tickets and itinerary (only after supplier issuance) -------------------------------------

export function ticketIssuedRequest(record: FulfilmentRecord, userId: string, nowUtc: string): BuildResult {
  return fromVerdict(ticketsVerified(record), () =>
    build('ticket_issued', 'ticketing', userId, `ticket_issued:${record.bookingId}`, null, { bookingReference: record.bookingReference }, nowUtc),
  );
}

export function itineraryRequest(record: FulfilmentRecord, userId: string, nowUtc: string): BuildResult {
  return fromVerdict(ticketsVerified(record), () => {
    if (!record.bookingReference) return { ok: false, reason: 'no_booking_reference' } as const;
    const legs: Array<Itinerary['legs'][number]> = [];
    const add = (leg: 'outbound' | 'return', segments: NonNullable<FulfilmentRecord['offer']['segments']>) => {
      for (const s of segments) {
        legs.push({
          leg,
          carrier: s.carrier,
          flightNumber: s.flightNumber,
          origin: s.origin,
          destination: s.destination,
          departureLocal: formatLocal(s.departureUtc, s.departureTimeZone),
          arrivalLocal: formatLocal(s.arrivalUtc, s.arrivalTimeZone),
        });
      }
    };
    try {
      add('outbound', record.offer.segments);
      if (record.offer.returnSegments) add('return', record.offer.returnSegments);
    } catch {
      return { ok: false, reason: 'invalid_time_or_zone' } as const;
    }
    const data: TemplateDataMap['itinerary'] = { bookingReference: record.bookingReference, legs };
    return build('itinerary', 'ticketing', userId, `itinerary:${record.bookingId}`, null, { ...data }, nowUtc);
  });
}

// --- payment (only after capture or a failure state) ------------------------------------------

export function paymentConfirmedRequest(intentId: string, status: PaymentStatus, record: FulfilmentRecord, userId: string, nowUtc: string): BuildResult {
  return fromVerdict(paymentCaptured(status), () =>
    build(
      'payment_confirmed',
      'payment',
      userId,
      `payment_confirmed:${intentId}`,
      null,
      { bookingReference: record.bookingReference, amountMinor: record.totalMinor, currency: record.currency },
      nowUtc,
    ),
  );
}

export function paymentFailedRequest(intentId: string, status: PaymentStatus, record: FulfilmentRecord, userId: string, nowUtc: string): BuildResult {
  return fromVerdict(paymentFailed(status), () =>
    build('payment_failed', 'payment', userId, `payment_failed:${intentId}`, null, { bookingReference: record.bookingReference }, nowUtc),
  );
}

// --- cancellation and refunds -----------------------------------------------------------------

const CANCELLATION_STATES: readonly FulfilmentStatus[] = ['cancellation_pending', 'cancelled', 'refund_pending', 'refunded'];

export function cancellationRequest(record: FulfilmentRecord, userId: string, nowUtc: string): BuildResult {
  if (!CANCELLATION_STATES.includes(record.status)) return { ok: false, reason: `status_${record.status}` };
  const view = customerStatus(record.status);
  return build(
    'cancellation_update',
    'booking',
    userId,
    `cancellation:${record.bookingId}:${record.status}`,
    null,
    { bookingReference: record.bookingReference, headline: view.headline, detail: view.detail },
    nowUtc,
  );
}

export function refundRequest(refundId: string, status: RefundStatus, eligibility: Eligibility, userId: string, confirmed: { amountMinor: number; currency: string } | null, nowUtc: string): BuildResult {
  // The confirmed amount is sent only for a completed refund.
  const amount = status === 'completed' ? confirmed : null;
  const wording = customerRefundWording(status, eligibility);
  return build('refund_update', 'refunds', userId, `refund:${refundId}:${status}`, null, { headline: wording, detail: 'Sign in to see the latest status.', confirmedAmount: amount }, nowUtc);
}

// --- support ---------------------------------------------------------------------------------

export function supportReplyRequest(requestId: string, category: string, responseSeq: number, userId: string, nowUtc: string): BuildResult {
  return build('support_reply', 'support', userId, `support_reply:${requestId}:${responseSeq}`, 'supportReplies', { requestId, category }, nowUtc);
}
