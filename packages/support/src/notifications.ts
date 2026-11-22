// Email notifications for support requests and refunds. They reuse the portal's message type and
// delivery outbox, so the same adapter boundary and send-once guarantee apply.
//
// Rules:
//   - Messages say that something has changed and point the customer to sign in. They never
//     include message text, ticket numbers, refund amounts that are not confirmed, or internal notes.
//   - No paid email provider is connected. The default adapter sends nothing (portal/notifications.ts).

import type { OutboundMessage } from '../../portal/src/notifications.ts';
import { customerRefundWording, type RefundRecord, type RefundStatus } from './refunds.ts';
import type { SupportRequest } from './support-requests.ts';

function message(
  kind: OutboundMessage['kind'],
  entityId: string,
  key: string,
  ownerUserId: string,
  bookingId: string | null,
  subject: string,
  body: string,
  nowUtc: string,
): OutboundMessage {
  return {
    id: `${entityId}:${kind}:${key}`,
    kind,
    audience: 'customer',
    recipientUserId: ownerUserId,
    bookingId: bookingId ?? '',
    subject,
    body,
    createdAt: nowUtc,
  };
}

export function requestReceivedMessage(request: SupportRequest, nowUtc: string): OutboundMessage {
  return message(
    'booking_update',
    request.id,
    'received',
    request.ownerUserId,
    request.bookingId,
    'We have received your support request',
    'Our team will review it. Sign in to see updates and reply.',
    nowUtc,
  );
}

export function staffResponseMessage(request: SupportRequest, responseSeq: number, nowUtc: string): OutboundMessage {
  return message(
    'booking_update',
    request.id,
    `response_${responseSeq}`,
    request.ownerUserId,
    request.bookingId,
    'There is an update on your support request',
    'Our team has replied to your request. Sign in to read the reply.',
    nowUtc,
  );
}

export function refundUpdateMessage(refund: RefundRecord, status: RefundStatus, nowUtc: string): OutboundMessage {
  return message(
    'payment_status',
    refund.id,
    status,
    refund.requestedBy,
    refund.bookingId,
    'Refund update',
    `${customerRefundWording(status, refund.eligibility)} Sign in for details.`,
    nowUtc,
  );
}
