// Customer dashboard: a customer's own bookings, split into upcoming and past trips.
//
// Only bookings owned by the signed-in customer are returned. The views reuse the fulfilment
// customer screen, so tickets are shown only when the supplier has issued them, and wording comes
// from status.ts. Internal reasons (lockedReason, blockedReason) are never shown to customers.

import type { Segment } from '../../flights/src/supplier.ts';
import { customerScreen } from '../../fulfilment/src/customer-view.ts';
import type { Actor } from './access.ts';
import { ownsBooking } from './access.ts';
import type { PortalBooking } from './model.ts';
import { categoryLabel, displayCategory, type DisplayCategory } from './status-category.ts';
import { customerTimeline, type CustomerTimelineItem } from './timeline.ts';
import { cancellationDecision, type RequestDecision } from './requests.ts';

export interface ItineraryLeg {
  readonly leg: 'outbound' | 'return';
  readonly origin: string;
  readonly destination: string;
  readonly departureUtc: string;
  readonly arrivalUtc: string;
  readonly departureTimeZone: string;
  readonly arrivalTimeZone: string;
  readonly carrier: string;
  readonly flightNumber: string;
}

export interface CustomerBookingView {
  readonly bookingId: string;
  readonly reference: string | null; // airline reference, shown only once the airline has issued one
  readonly category: DisplayCategory;
  readonly categoryLabel: string;
  readonly headline: string;
  readonly detail: string;
  readonly showTickets: boolean;
  readonly passengers: readonly { readonly index: number; readonly name: string }[];
  readonly tickets: readonly { readonly passengerIndex: number; readonly number: string }[];
  readonly documentsNote: string;
  readonly itinerary: readonly ItineraryLeg[];
  readonly departureUtc: string | null;
  readonly arrivalUtc: string | null;
  readonly refundable: 'yes' | 'no' | 'not_confirmed';
  readonly timeline: readonly CustomerTimelineItem[];
  readonly cancellation: RequestDecision;
}

export interface CustomerDashboard {
  readonly upcoming: readonly CustomerBookingView[];
  readonly past: readonly CustomerBookingView[];
}

function legs(segments: readonly Segment[] | undefined, leg: 'outbound' | 'return'): ItineraryLeg[] {
  return (segments ?? []).map((s) => ({
    leg,
    origin: s.origin,
    destination: s.destination,
    departureUtc: s.departureUtc,
    arrivalUtc: s.arrivalUtc,
    departureTimeZone: s.departureTimeZone,
    arrivalTimeZone: s.arrivalTimeZone,
    carrier: s.carrier,
    flightNumber: s.flightNumber,
  }));
}

function latest(values: readonly string[]): string | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

function earliest(values: readonly string[]): string | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
}

function refundableValue(refundable: boolean | null | undefined): 'yes' | 'no' | 'not_confirmed' {
  if (refundable === true) return 'yes';
  if (refundable === false) return 'no';
  return 'not_confirmed'; // the supplier did not say: never shown as "no"
}

// Returns the customer's view of one booking, or null if the actor does not own it.
export function customerBooking(actor: Actor, booking: PortalBooking): CustomerBookingView | null {
  if (!ownsBooking(actor, booking.ownerUserId)) return null;
  const record = booking.record;
  const screen = customerScreen(record);
  const all = [...legs(record.offer.segments, 'outbound'), ...legs(record.offer.returnSegments, 'return')];
  const departures = all.map((l) => l.departureUtc);
  const arrivals = all.map((l) => l.arrivalUtc);
  return {
    bookingId: record.bookingId,
    reference: screen.bookingReference,
    category: displayCategory(record.status),
    categoryLabel: categoryLabel(record.status),
    headline: screen.status.headline,
    detail: screen.status.detail,
    showTickets: screen.status.showTickets,
    passengers: screen.passengers.map((p) => ({ index: p.index, name: p.name })),
    tickets: screen.tickets.map((t) => ({ passengerIndex: t.passengerIndex, number: t.number })),
    documentsNote: screen.status.showTickets
      ? 'Your ticket numbers are shown above. Downloadable ticket files are not available yet.'
      : 'Ticket numbers appear here once the airline has issued your tickets.',
    itinerary: all,
    departureUtc: earliest(departures),
    arrivalUtc: latest(arrivals),
    refundable: refundableValue(record.offer.fare?.refundable),
    timeline: customerTimeline(booking.history),
    cancellation: cancellationDecision(actor, booking),
  };
}

// Splits the owner's bookings into upcoming (last arrival not yet passed) and past.
// Upcoming is sorted by first departure (soonest first); past by most recent first.
export function customerDashboard(actor: Actor, bookings: readonly PortalBooking[], nowUtc: string): CustomerDashboard {
  const views = bookings
    .map((b) => customerBooking(actor, b))
    .filter((v): v is CustomerBookingView => v !== null);
  const isUpcoming = (v: CustomerBookingView) => v.arrivalUtc === null || Date.parse(v.arrivalUtc) >= Date.parse(nowUtc);
  const upcoming = views
    .filter(isUpcoming)
    .sort((a, b) => Date.parse(a.departureUtc ?? nowUtc) - Date.parse(b.departureUtc ?? nowUtc));
  const past = views
    .filter((v) => !isUpcoming(v))
    .sort((a, b) => Date.parse(b.arrivalUtc ?? nowUtc) - Date.parse(a.arrivalUtc ?? nowUtc));
  return { upcoming, past };
}
