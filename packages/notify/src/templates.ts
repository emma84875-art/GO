// Email templates. Every template takes a typed data object with only the fields it needs.
//
// Passenger names, dates of birth, nationality, document numbers and ticket numbers are not
// fields of any template, so they cannot be rendered. Authentication links are built at send time
// from a nonce, so the link (and its token) is never stored in the queue.

import { formatMoney, renderLayout, safeHttpsUrl, subjectAndBody, safeText, type RenderedEmail } from './render.ts';

export const TEMPLATE_IDS = [
  'account_verification',
  'password_reset',
  'security_alert',
  'booking_received',
  'booking_status',
  'payment_confirmed',
  'payment_failed',
  'ticket_issued',
  'itinerary',
  'cancellation_update',
  'refund_update',
  'support_reply',
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const REFERENCE_PATTERN = /^[A-Z2-9]{6}$/;

export interface Itinerary {
  readonly bookingReference: string;
  readonly legs: readonly {
    readonly leg: 'outbound' | 'return';
    readonly carrier: string;
    readonly flightNumber: string;
    readonly origin: string;
    readonly destination: string;
    readonly departureLocal: string; // already formatted in the departure zone
    readonly arrivalLocal: string;
  }[];
}

export interface TemplateDataMap {
  account_verification: { readonly nonce: string; readonly expiresInMinutes: number };
  password_reset: { readonly nonce: string; readonly expiresInMinutes: number };
  security_alert: { readonly event: 'password_changed' | 'new_sign_in' | 'email_changed' | 'mfa_changed'; readonly occurredAtUtc: string };
  booking_received: { readonly bookingReference: string | null };
  booking_status: { readonly bookingReference: string | null; readonly headline: string; readonly detail: string };
  payment_confirmed: { readonly bookingReference: string | null; readonly amountMinor: number; readonly currency: string };
  payment_failed: { readonly bookingReference: string | null };
  ticket_issued: { readonly bookingReference: string | null };
  itinerary: Itinerary;
  cancellation_update: { readonly bookingReference: string | null; readonly headline: string; readonly detail: string };
  refund_update: { readonly headline: string; readonly detail: string; readonly confirmedAmount: { readonly amountMinor: number; readonly currency: string } | null };
  support_reply: { readonly requestId: string; readonly category: string };
}

export interface RenderContext {
  readonly appUrl: string; // https base of the GO web app
  readonly authLink: (kind: 'verify' | 'reset', nonce: string) => string;
}

function reference(value: string | null): string | null {
  if (value === null) return null;
  if (!REFERENCE_PATTERN.test(value)) throw new Error('invalid_reference');
  return value;
}

function refDetails(ref: string | null): { label: string; value: string }[] {
  return ref ? [{ label: 'Booking reference', value: ref }] : [];
}

function signIn(ctx: RenderContext, path: string, label: string): { label: string; url: string } {
  return { label, url: safeHttpsUrl(`${ctx.appUrl.replace(/\/+$/, '')}${path}`) };
}

function minutes(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1 || n > 60) throw new Error('invalid_expiry');
  return n;
}

const SECURITY_TEXT: Record<TemplateDataMap['security_alert']['event'], string> = {
  password_changed: 'The password on your GO account was changed.',
  new_sign_in: 'A new sign-in to your GO account was recorded.',
  email_changed: 'The email address on your GO account was changed.',
  mfa_changed: 'Two-factor sign-in was changed on your GO account.',
};

export function renderTemplate<K extends TemplateId>(id: K, data: TemplateDataMap[K], ctx: RenderContext): RenderedEmail {
  switch (id) {
    case 'account_verification': {
      const d = data as TemplateDataMap['account_verification'];
      const layout = renderLayout({
        title: 'Confirm your email address',
        preheader: 'Confirm your email to finish setting up your GO account.',
        paragraphs: ['Thanks for creating a GO account. Confirm your email address to finish setting up.', `This link expires in ${minutes(d.expiresInMinutes)} minutes and works once.`],
        cta: { label: 'Confirm email', url: ctx.authLink('verify', d.nonce) },
        footerNote: 'If you did not create a GO account, you can ignore this message.',
      });
      return subjectAndBody('Confirm your GO email address', layout);
    }
    case 'password_reset': {
      const d = data as TemplateDataMap['password_reset'];
      const layout = renderLayout({
        title: 'Reset your password',
        preheader: 'Use this link to set a new GO password.',
        paragraphs: ['We received a request to reset your GO password. Use the button below to choose a new one.', `This link expires in ${minutes(d.expiresInMinutes)} minutes and works once.`],
        cta: { label: 'Reset password', url: ctx.authLink('reset', d.nonce) },
        footerNote: 'If you did not ask for this, ignore this message. Your password will not change.',
      });
      return subjectAndBody('Reset your GO password', layout);
    }
    case 'security_alert': {
      const d = data as TemplateDataMap['security_alert'];
      const layout = renderLayout({
        title: 'Security alert',
        preheader: SECURITY_TEXT[d.event],
        paragraphs: [SECURITY_TEXT[d.event], 'If this was you, no action is needed.', 'If this was not you, reset your password now and contact support.'],
        details: [{ label: 'Time (UTC)', value: safeText(d.occurredAtUtc, 40) }],
        cta: signIn(ctx, '/account/security', 'Review account security'),
        footerNote: 'Security alerts are required and cannot be turned off.',
      });
      return subjectAndBody('Security alert for your GO account', layout);
    }
    case 'booking_received': {
      const d = data as TemplateDataMap['booking_received'];
      const ref = reference(d.bookingReference);
      const layout = renderLayout({
        title: 'We have received your booking',
        preheader: 'Your booking request is with us. It is not confirmed yet.',
        paragraphs: ['We have received your booking request. It is not confirmed yet. We will email you when the airline has issued your tickets.'],
        details: refDetails(ref),
        cta: signIn(ctx, '/bookings', 'View my bookings'),
        footerNote: 'A booking is confirmed only when the airline has issued your tickets and payment is complete.',
      });
      return subjectAndBody(ref ? `Booking ${ref} received` : 'Your booking has been received', layout);
    }
    case 'booking_status': {
      const d = data as TemplateDataMap['booking_status'];
      const ref = reference(d.bookingReference);
      const layout = renderLayout({
        title: 'Booking update',
        preheader: d.headline,
        paragraphs: [d.headline, d.detail],
        details: refDetails(ref),
        cta: signIn(ctx, '/bookings', 'View booking status'),
        footerNote: 'Sign in for the latest status. Ticket numbers are only shown in your account.',
      });
      return subjectAndBody(ref ? `Booking ${ref}: update` : 'Booking update', layout);
    }
    case 'payment_confirmed': {
      const d = data as TemplateDataMap['payment_confirmed'];
      const ref = reference(d.bookingReference);
      const amount = formatMoney(d.amountMinor, d.currency);
      const layout = renderLayout({
        title: 'Payment confirmed',
        preheader: `We have taken your payment of ${amount}.`,
        paragraphs: [`We have taken your payment of ${amount}.`, 'Your tickets were issued before the payment was taken.'],
        details: [...refDetails(ref), { label: 'Amount', value: amount }],
        cta: signIn(ctx, '/bookings', 'View my bookings'),
        footerNote: 'Payment messages are required and cannot be turned off.',
      });
      return subjectAndBody(ref ? `Payment confirmed for booking ${ref}` : 'Payment confirmed', layout);
    }
    case 'payment_failed': {
      const d = data as TemplateDataMap['payment_failed'];
      const ref = reference(d.bookingReference);
      const layout = renderLayout({
        title: 'Payment did not go through',
        preheader: 'Your payment did not go through and no booking was confirmed.',
        paragraphs: ['Your payment did not go through, so no booking has been confirmed.', 'If any money was held on your card, it will be released by your bank or payment provider.'],
        details: refDetails(ref),
        cta: signIn(ctx, '/bookings', 'View booking'),
        footerNote: 'Contact support if you have questions about this payment.',
      });
      return subjectAndBody('Payment did not go through', layout);
    }
    case 'ticket_issued': {
      const d = data as TemplateDataMap['ticket_issued'];
      const ref = reference(d.bookingReference);
      const layout = renderLayout({
        title: 'Your tickets have been issued',
        preheader: 'The airline has issued your tickets.',
        paragraphs: ['The airline has issued your tickets. Sign in to view them. For your security, ticket numbers are not included in this email.'],
        details: refDetails(ref),
        cta: signIn(ctx, '/bookings', 'View my tickets'),
        footerNote: 'Keep your booking reference safe. Ticket numbers appear only when you sign in.',
      });
      return subjectAndBody(ref ? `Tickets issued for booking ${ref}` : 'Your tickets have been issued', layout);
    }
    case 'itinerary': {
      const d = data as TemplateDataMap['itinerary'];
      const ref = reference(d.bookingReference);
      if (ref === null) throw new Error('invalid_reference');
      const legs = d.legs.map((l) => ({
        label: `${l.leg === 'outbound' ? 'Outbound' : 'Return'} ${safeText(l.flightNumber, 12)}`,
        value: `${safeText(l.origin, 60)} to ${safeText(l.destination, 60)}. Departs ${safeText(l.departureLocal, 80)}. Arrives ${safeText(l.arrivalLocal, 80)}.`,
      }));
      const layout = renderLayout({
        title: 'Your itinerary',
        preheader: `Itinerary for booking ${ref}.`,
        paragraphs: ['Here is your itinerary. Times are local to each airport. Check your passenger details and ticket numbers in your account.'],
        details: [{ label: 'Booking reference', value: ref }, ...legs],
        cta: signIn(ctx, '/bookings', 'Open my itinerary'),
        footerNote: 'Times shown are local to each airport. Check them against your airline before you travel.',
      });
      return subjectAndBody(`Itinerary for booking ${ref}`, layout);
    }
    case 'cancellation_update': {
      const d = data as TemplateDataMap['cancellation_update'];
      const ref = reference(d.bookingReference);
      const layout = renderLayout({
        title: 'Cancellation update',
        preheader: d.headline,
        paragraphs: [d.headline, d.detail],
        details: refDetails(ref),
        cta: signIn(ctx, '/support', 'Open support'),
        footerNote: 'Cancellation follows the fare rules. A refund is not guaranteed.',
      });
      return subjectAndBody(ref ? `Cancellation update for booking ${ref}` : 'Cancellation update', layout);
    }
    case 'refund_update': {
      const d = data as TemplateDataMap['refund_update'];
      const confirmed = d.confirmedAmount ? formatMoney(d.confirmedAmount.amountMinor, d.confirmedAmount.currency) : null;
      const layout = renderLayout({
        title: 'Refund update',
        preheader: d.headline,
        paragraphs: [d.headline, d.detail],
        details: confirmed ? [{ label: 'Refunded amount', value: confirmed }] : [],
        cta: signIn(ctx, '/support', 'View refund status'),
        footerNote: 'We send a refund amount only once it has been confirmed.',
      });
      return subjectAndBody('Refund update', layout);
    }
    case 'support_reply': {
      const d = data as TemplateDataMap['support_reply'];
      const layout = renderLayout({
        title: 'There is an update on your request',
        preheader: 'Our team has replied to your support request.',
        paragraphs: ['Our team has replied to your support request. Sign in to read the reply and respond.'],
        details: [{ label: 'Request', value: safeText(d.requestId, 40) }],
        cta: signIn(ctx, '/support', 'Read the reply'),
        footerNote: 'Replies are only shown in your account. Message text is never sent by email.',
      });
      return subjectAndBody('Update on your GO support request', layout);
    }
    default:
      // An unknown template is refused, never rendered as a blank email.
      throw new Error('unknown_template');
  }
}
