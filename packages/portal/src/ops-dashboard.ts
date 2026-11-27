// Operations dashboard for support and admin staff.
//
// Every function here requires a staff role. Staff see passenger date of birth and nationality
// (privacy.ts 'support' view). Ticket numbers are masked to the last four digits. Internal reasons
// (lockedReason, blockedReason) are visible to staff only, and are never shown to customers.
//
// Attention and hold-expiry logic reads the clock and history, and never changes a status.

import { holdExpiryState, minutesRemaining, type ExpiryState } from '../../core/src/hold-expiry.ts';
import { passengersFor, ticketsFor, type PassengerView, type TicketView } from '../../fulfilment/src/privacy.ts';
import type { FulfilmentStatus } from '../../fulfilment/src/status.ts';
import type { AuditEntry } from '../../payments/src/store.ts';
import { requireOperations, type Actor } from './access.ts';
import type { PortalBooking } from './model.ts';
import { categoryLabel, displayCategory, NEEDS_CHECKING, type DisplayCategory } from './status-category.ts';
import { buildTimeline, lastChangedAt, type TimelineItem } from './timeline.ts';

export interface OpsSearch {
  readonly bookingId?: string;
  readonly reference?: string;
  readonly supplierOrderId?: string;
  readonly paymentIntentId?: string;
  readonly passengerSurname?: string;
}

export interface OpsSummary {
  readonly bookingId: string;
  readonly ownerUserId: string;
  readonly status: FulfilmentStatus;
  readonly category: DisplayCategory;
  readonly categoryLabel: string;
  readonly reference: string | null;
  readonly orderId: string | null;
  readonly intentId: string;
  readonly lastChangedAt: string | null;
}

export const SEARCH_LIMIT = 50;
const MIN_SURNAME_LENGTH = 2;

function summarise(booking: PortalBooking): OpsSummary {
  const r = booking.record;
  return {
    bookingId: r.bookingId,
    ownerUserId: booking.ownerUserId,
    status: r.status,
    category: displayCategory(r.status),
    categoryLabel: categoryLabel(r.status),
    reference: r.bookingReference,
    orderId: r.orderId,
    intentId: r.intentId,
    lastChangedAt: lastChangedAt(booking.history),
  };
}

// Finds bookings by exact identifiers or by passenger surname. At least one criterion is required,
// so the dashboard never lists every booking. Surname search needs two or more characters.
export function searchBookings(actor: Actor, query: OpsSearch, bookings: readonly PortalBooking[]): OpsSummary[] {
  requireOperations(actor);
  const bookingId = query.bookingId?.trim().toLowerCase();
  const reference = query.reference?.trim().toUpperCase();
  const orderId = query.supplierOrderId?.trim();
  const intentId = query.paymentIntentId?.trim();
  const surname = query.passengerSurname?.trim().toLowerCase();
  if (!bookingId && !reference && !orderId && !intentId && !surname) {
    throw new RangeError('Enter a booking ID, reference, supplier order ID, payment ID or passenger surname.');
  }
  if (surname !== undefined && surname.length > 0 && surname.length < MIN_SURNAME_LENGTH) {
    throw new RangeError(`Surname search needs at least ${MIN_SURNAME_LENGTH} characters.`);
  }
  const matches = bookings.filter((b) => {
    const r = b.record;
    if (bookingId && r.bookingId.toLowerCase() === bookingId) return true;
    if (reference && r.bookingReference === reference) return true;
    if (orderId && r.orderId === orderId) return true;
    if (intentId && r.intentId === intentId) return true;
    if (surname && surname.length >= MIN_SURNAME_LENGTH && r.passengers.some((p) => p.lastName.toLowerCase() === surname)) return true;
    return false;
  });
  return matches.slice(0, SEARCH_LIMIT).map(summarise);
}

export interface HoldWatchItem {
  readonly bookingId: string;
  readonly status: FulfilmentStatus;
  readonly holdExpiresAtUtc: string;
  readonly expiry: ExpiryState;
  readonly minutesRemaining: number;
}

// Holds that are not yet ordered, soonest expiry first. Expired holds stay in the list so staff
// can see that the authorisation must be released.
export function holdWatch(actor: Actor, bookings: readonly PortalBooking[], nowUtc: string, warnMinutes = 10): HoldWatchItem[] {
  requireOperations(actor);
  return bookings
    .filter((b) => b.record.status === 'quoted' || b.record.status === 'authorised')
    .map((b) => ({
      bookingId: b.record.bookingId,
      status: b.record.status,
      holdExpiresAtUtc: b.record.holdExpiresAtUtc,
      expiry: holdExpiryState(b.record.holdExpiresAtUtc, nowUtc, warnMinutes),
      minutesRemaining: minutesRemaining(b.record.holdExpiresAtUtc, nowUtc),
    }))
    .sort((a, b) => Date.parse(a.holdExpiresAtUtc) - Date.parse(b.holdExpiresAtUtc));
}

export type AttentionSeverity = 'high' | 'medium' | 'low';

export interface AttentionItem {
  readonly bookingId: string;
  readonly status: FulfilmentStatus;
  readonly severity: AttentionSeverity;
  readonly reasons: readonly string[];
}

const IN_FLIGHT_WITHOUT_OUTCOME: readonly FulfilmentStatus[] = ['partner_ordered', 'ticketing_pending', 'cancellation_pending', 'refund_pending'];
const RANK: Record<AttentionSeverity, number> = { high: 0, medium: 1, low: 2 };

// Bookings that a person should look at: supplier outcome unknown or partial, blocked steps,
// in-flight steps with no change for too long, and failed bookings to confirm are released.
export function needsAttention(actor: Actor, bookings: readonly PortalBooking[], nowUtc: string, delayMinutes = 30): AttentionItem[] {
  requireOperations(actor);
  const items: AttentionItem[] = [];
  for (const b of bookings) {
    const r = b.record;
    const reasons: { severity: AttentionSeverity; text: string }[] = [];
    if (NEEDS_CHECKING.includes(r.status)) {
      reasons.push({ severity: 'high', text: 'The supplier outcome is unknown or partial. Check with the airline before any retry.' });
    }
    if (r.blockedReason) reasons.push({ severity: 'high', text: `Blocked: ${r.blockedReason}` });
    if (r.lockedReason && !NEEDS_CHECKING.includes(r.status)) reasons.push({ severity: 'high', text: `Locked: ${r.lockedReason}` });
    if (IN_FLIGHT_WITHOUT_OUTCOME.includes(r.status)) {
      const last = lastChangedAt(b.history);
      if (last === null) {
        reasons.push({ severity: 'medium', text: 'No change time is recorded for this booking.' });
      } else {
        const idleMinutes = Math.floor((Date.parse(nowUtc) - Date.parse(last)) / 60_000);
        if (idleMinutes >= delayMinutes) reasons.push({ severity: 'medium', text: `No change for ${idleMinutes} minutes.` });
      }
    }
    if (r.status === 'failed') {
      reasons.push({ severity: 'low', text: 'Not completed. Confirm the payment authorisation was released.' });
    }
    if (reasons.length === 0) continue;
    const severity = reasons.reduce<AttentionSeverity>((worst, reason) => (RANK[reason.severity] < RANK[worst] ? reason.severity : worst), 'low');
    items.push({ bookingId: r.bookingId, status: r.status, severity, reasons: reasons.map((x) => x.text) });
  }
  return items.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.bookingId.localeCompare(b.bookingId));
}

export interface Investigation {
  readonly bookingId: string;
  readonly ownerUserId: string;
  readonly status: FulfilmentStatus;
  readonly categoryLabel: string;
  readonly reference: string | null;
  readonly supplierOrderId: string | null;
  readonly paymentIntentId: string;
  readonly holdExpiresAtUtc: string | null;
  readonly holdExpiry: ExpiryState | null;
  readonly lockedReason: string | null;
  readonly blockedReason: string | null;
  readonly passengers: readonly PassengerView[];
  readonly tickets: readonly TicketView[];
  readonly totalMinor: number;
  readonly currency: string;
  readonly timeline: readonly TimelineItem[];
}

// Full detail for one booking, for investigating a failure or delay.
export function investigate(actor: Actor, booking: PortalBooking, paymentAudit: readonly AuditEntry[], nowUtc: string, warnMinutes = 10): Investigation {
  requireOperations(actor);
  const r = booking.record;
  const holdOpen = r.status === 'quoted' || r.status === 'authorised';
  return {
    bookingId: r.bookingId,
    ownerUserId: booking.ownerUserId,
    status: r.status,
    categoryLabel: categoryLabel(r.status),
    reference: r.bookingReference,
    supplierOrderId: r.orderId,
    paymentIntentId: r.intentId,
    holdExpiresAtUtc: holdOpen ? r.holdExpiresAtUtc : null,
    holdExpiry: holdOpen ? holdExpiryState(r.holdExpiresAtUtc, nowUtc, warnMinutes) : null,
    lockedReason: r.lockedReason,
    blockedReason: r.blockedReason,
    passengers: passengersFor('support', r.passengers),
    tickets: ticketsFor('support', r.documents),
    totalMinor: r.totalMinor,
    currency: r.currency,
    timeline: buildTimeline(booking.history, paymentAudit),
  };
}
