// Booking notifications: messages, an email adapter boundary, and a delivery outbox.
//
// Rules:
//   - A message says only what the status says. "Ticket issued" is generated only when the
//     fulfilment record has supplier documents and the status is ticketed or confirmed.
//   - Email never contains ticket numbers, passenger names or payment details. Customers sign in
//     to see them. The message is sent to a user ID; the adapter resolves the address on the server.
//   - No real email provider is included. UnconfiguredEmailAdapter sends nothing and reports
//     not_configured. A paid provider needs owner approval and is connected later behind the
//     same NotificationAdapter interface.
//   - A message is marked sent only when the adapter reports sent. A thrown error or an
//     unconfigured adapter is recorded as failed or not_configured, never as sent.
//   - A message with the same ID is never sent twice once it has been sent.

import type { FulfilmentStatus } from '../../fulfilment/src/status.ts';
import { customerStatus } from '../../fulfilment/src/status.ts';
import type { PaymentStatus } from '../../payments/src/state.ts';
import type { PortalBooking } from './model.ts';
import { categoryLabel } from './status-category.ts';

export type NotificationKind = 'booking_update' | 'payment_status' | 'ticket_issued' | 'cancellation' | 'operational_problem';

export interface OutboundMessage {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly audience: 'customer' | 'staff';
  readonly recipientUserId: string | null; // customer owner ID; null for the staff queue
  readonly bookingId: string;
  readonly subject: string;
  readonly body: string;
  readonly createdAt: string;
}

const CANCELLATION_STATUSES: readonly FulfilmentStatus[] = ['cancellation_pending', 'cancelled', 'refund_pending', 'refunded'];

function referenceLine(booking: PortalBooking): string {
  const ref = booking.record.bookingReference;
  return ref ? `Airline reference: ${ref}.` : '';
}

function customerMessage(kind: NotificationKind, key: string, booking: PortalBooking, subject: string, body: string, nowUtc: string): OutboundMessage {
  return {
    id: `${booking.record.bookingId}:${kind}:${key}`,
    kind,
    audience: 'customer',
    recipientUserId: booking.ownerUserId,
    bookingId: booking.record.bookingId,
    subject,
    body,
    createdAt: nowUtc,
  };
}

export function bookingUpdateMessage(booking: PortalBooking, nowUtc: string): OutboundMessage {
  const view = customerStatus(booking.record.status);
  const body = [view.detail, referenceLine(booking), 'Sign in to see the latest details.'].filter(Boolean).join(' ');
  return customerMessage('booking_update', booking.record.status, booking, `Booking update: ${view.headline}`, body, nowUtc);
}

// Returns null unless the supplier has issued documents and the status says so.
export function ticketIssuedMessage(booking: PortalBooking, nowUtc: string): OutboundMessage | null {
  const r = booking.record;
  if (r.documents.length === 0) return null;
  if (r.status !== 'ticketed' && r.status !== 'confirmed') return null;
  const body = [
    `Your airline has issued tickets for your booking.`,
    referenceLine(booking),
    'For your security, ticket numbers are not included in this email. Sign in to view them.',
  ].filter(Boolean).join(' ');
  return customerMessage('ticket_issued', r.status, booking, 'Your tickets have been issued', body, nowUtc);
}

export function cancellationMessage(booking: PortalBooking, nowUtc: string): OutboundMessage | null {
  if (!CANCELLATION_STATUSES.includes(booking.record.status)) return null;
  const view = customerStatus(booking.record.status);
  return customerMessage('cancellation', booking.record.status, booking, `Cancellation update: ${view.headline}`, view.detail, nowUtc);
}

const PAYMENT_WORDING: Partial<Record<PaymentStatus, string>> = {
  authorised: 'Your payment is authorised. It will only be taken once your tickets are issued.',
  captured: 'Your payment has been taken because your tickets are issued.',
  released: 'Your payment authorisation was released. You were not charged.',
  failed: 'Your payment did not go through. No booking has been confirmed.',
  expired: 'Your payment authorisation expired before the booking was completed. You were not charged.',
  refund_pending: 'Your refund has been requested.',
  refunded: 'Your refund has been completed.',
};

// Returns null for payment states that have no safe customer wording yet (for example
// review_required). Nothing is said about money that the payment record does not show.
export function paymentStatusMessage(booking: PortalBooking, paymentStatus: PaymentStatus, nowUtc: string): OutboundMessage | null {
  const wording = PAYMENT_WORDING[paymentStatus];
  if (!wording) return null;
  return customerMessage('payment_status', paymentStatus, booking, 'Payment update', wording, nowUtc);
}

// For the staff queue. Carries the reasons from needsAttention, and no passenger detail.
export function operationalProblemMessage(booking: PortalBooking, reasons: readonly string[], nowUtc: string): OutboundMessage {
  const id = `${booking.record.bookingId}:operational_problem:${booking.record.status}`;
  return {
    id,
    kind: 'operational_problem',
    audience: 'staff',
    recipientUserId: null,
    bookingId: booking.record.bookingId,
    subject: `Booking needs checking: ${booking.record.bookingId}`,
    body: `Status: ${categoryLabel(booking.record.status)}. ${reasons.join(' ')}`,
    createdAt: nowUtc,
  };
}

// --- Adapter boundary -------------------------------------------------------------------------

export type SendResult =
  | { readonly state: 'sent'; readonly providerMessageId: string }
  | { readonly state: 'failed'; readonly reason: string }
  | { readonly state: 'not_configured' };

export interface NotificationAdapter {
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
}

// The default. Sends nothing and reports that no provider is configured.
export class UnconfiguredEmailAdapter implements NotificationAdapter {
  readonly name = 'email:not_configured';
  async send(): Promise<SendResult> {
    return { state: 'not_configured' };
  }
}

// Records messages in memory. Used for development and tests. It sends nothing to anyone.
export class RecordingAdapter implements NotificationAdapter {
  readonly name = 'recording';
  readonly sent: OutboundMessage[] = [];
  failNext: string | null = null;
  private counter = 0;

  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.failNext !== null) {
      const reason = this.failNext;
      this.failNext = null;
      return { state: 'failed', reason };
    }
    this.sent.push(message);
    this.counter += 1;
    return { state: 'sent', providerMessageId: `rec_${this.counter}` };
  }
}

export type OutboxState = 'sent' | 'failed' | 'not_configured';

export interface OutboxEntry {
  readonly message: OutboundMessage;
  readonly state: OutboxState;
  readonly reason: string | null;
  readonly attempts: number;
  readonly providerMessageId: string | null;
}

// Tracks delivery per message ID. A sent message is never sent again. A failed message can be
// retried by calling dispatch again. A failure does not change the booking status.
export class Outbox {
  private readonly entries = new Map<string, OutboxEntry>();

  get(id: string): OutboxEntry | undefined {
    return this.entries.get(id);
  }

  all(): readonly OutboxEntry[] {
    return [...this.entries.values()];
  }

  async dispatch(adapter: NotificationAdapter, message: OutboundMessage): Promise<OutboxEntry> {
    const existing = this.entries.get(message.id);
    if (existing?.state === 'sent') return existing;
    const attempts = (existing?.attempts ?? 0) + 1;
    let result: SendResult;
    try {
      result = await adapter.send(message);
    } catch {
      // The provider's error text is not stored, because it can contain addresses or payloads.
      result = { state: 'failed', reason: 'provider_error' };
    }
    const entry: OutboxEntry =
      result.state === 'sent'
        ? { message, state: 'sent', reason: null, attempts, providerMessageId: result.providerMessageId }
        : result.state === 'failed'
          ? { message, state: 'failed', reason: result.reason, attempts, providerMessageId: null }
          : { message, state: 'not_configured', reason: 'No email provider is configured.', attempts, providerMessageId: null };
    this.entries.set(message.id, entry);
    return entry;
  }
}
