// Portal tests: customer access, staff access, privacy of each view, status wording,
// booking timelines, request rules, hold and attention lists, and notification delivery.
// All suppliers, documents and payments here are development fixtures. These tests prove the
// portal's rules, not any airline's or provider's behaviour.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { Offer } from '../../flights/src/supplier.ts';
import { FulfilmentStore } from '../../fulfilment/src/store.ts';
import type { FulfilmentStatus } from '../../fulfilment/src/status.ts';
import { customerStatus } from '../../fulfilment/src/status.ts';
import type { AuditEntry } from '../../payments/src/store.ts';
import type { PortalBooking } from '../src/model.ts';
import type { Actor } from '../src/access.ts';
import { AccessDeniedError } from '../src/access.ts';
import { customerBooking, customerDashboard } from '../src/customer-dashboard.ts';
import { cancellationDecision, requestCancellation, requestSupport, SUPPORT_MESSAGE_MAX } from '../src/requests.ts';
import { searchBookings, holdWatch, needsAttention, investigate, SEARCH_LIMIT } from '../src/ops-dashboard.ts';
import { displayCategory, categoryLabel } from '../src/status-category.ts';
import { buildTimeline, customerTimeline, lastChangedAt } from '../src/timeline.ts';
import {
  bookingUpdateMessage, ticketIssuedMessage, cancellationMessage, paymentStatusMessage,
  operationalProblemMessage, RecordingAdapter, UnconfiguredEmailAdapter, Outbox, type NotificationAdapter, type OutboundMessage,
} from '../src/notifications.ts';

const NOW = '2026-11-13T09:00:00Z';
const ALICE = 'user-alice';
const BOB = 'user-bob';
const SUPPORT: Actor = { userId: 'staff-1', role: 'support' };
const ADMIN: Actor = { userId: 'staff-2', role: 'admin' };
const ALICE_ACTOR: Actor = { userId: ALICE, role: 'customer' };
const BOB_ACTOR: Actor = { userId: BOB, role: 'customer' };

const ALL_STATUSES: readonly FulfilmentStatus[] = [
  'held', 'authorised', 'order_pending', 'ticketing_pending', 'ticketed', 'partially_fulfilled', 'confirmed',
  'order_unknown', 'ticketing_unknown', 'failed', 'expired', 'cancellation_pending', 'cancelled', 'refund_pending', 'refunded',
];

function offer(id: string, withReturn = false, past = false): Offer {
  const outbound = {
    origin: 'LOS', destination: 'LHR',
    departureUtc: past ? '2026-10-01T10:00:00Z' : '2026-12-01T10:00:00Z',
    arrivalUtc: past ? '2026-10-01T17:00:00Z' : '2026-12-01T17:00:00Z',
    departureTimeZone: 'Africa/Lagos', arrivalTimeZone: 'Europe/London',
    carrier: 'BA', flightNumber: 'BA75',
  };
  const inbound = {
    origin: 'LHR', destination: 'LOS',
    departureUtc: past ? '2026-10-10T18:00:00Z' : '2026-12-10T18:00:00Z',
    arrivalUtc: past ? '2026-10-11T06:00:00Z' : '2026-12-11T06:00:00Z',
    departureTimeZone: 'Europe/London', arrivalTimeZone: 'Africa/Lagos',
    carrier: 'BA', flightNumber: 'BA74',
  };
  return {
    id,
    supplierPrice: { amountMinor: 85_000_000, currency: 'NGN' },
    displayPrice: { amountMinor: 85_000_000, currency: 'NGN' },
    expiresAtUtc: '2026-11-13T12:00:00Z',
    segments: [outbound],
    ...(withReturn ? { returnSegments: [inbound] } : {}),
    fare: { checkedBags: 1, cabinBags: 1, refundable: false, changeable: null, restrictions: [] },
  };
}

interface Options {
  readonly id: string;
  readonly owner: string;
  readonly path?: readonly FulfilmentStatus[];
  readonly at?: readonly (string | null)[]; // timestamp for each step; null means "not recorded"
  readonly documents?: { passengerIndex: number; number: string }[];
  readonly reference?: string | null;
  readonly orderId?: string | null;
  readonly passengers?: { type: 'adult' | 'child' | 'infant'; firstName: string; lastName: string; dateOfBirth: string; nationality: string }[];
  readonly holdExpiresAtUtc?: string;
  readonly lockedReason?: string | null;
  readonly blockedReason?: string | null;
  readonly withReturn?: boolean;
  readonly past?: boolean; // trip dates in the past
  readonly intentId?: string;
}

// Builds a booking through the real fulfilment store, so every status move is checked by the
// legal move table. 'held' is the starting point; path lists the moves that follow.
function book(options: Options): PortalBooking {
  const store = new FulfilmentStore();
  const passengers = options.passengers ?? [{ type: 'adult' as const, firstName: 'Ada', lastName: 'Okafor', dateOfBirth: '1990-05-14', nationality: 'NG' }];
  store.create({
    bookingId: options.id, status: 'held', intentId: options.intentId ?? `intent-${options.id}`, offer: offer(`offer-${options.id}`, options.withReturn ?? false, options.past ?? false),
    passengers, totalMinor: 85_000_000, currency: 'NGN',
    holdExpiresAtUtc: options.holdExpiresAtUtc ?? '2026-11-13T09:30:00Z', orderId: null, bookingReference: null,
    documents: [], lockedReason: null, blockedReason: null,
  });
  const path = options.path ?? [];
  path.forEach((to, i) => {
    const at = options.at?.[i];
    store.transition(options.id, to, `event_${to}`, at ?? '', {});
  });
  const finalPatch = {
    ...(options.reference !== undefined ? { bookingReference: options.reference } : {}),
    ...(options.orderId !== undefined ? { orderId: options.orderId } : {}),
    ...(options.documents ? { documents: options.documents.map((d) => ({ type: 'electronic_ticket' as const, number: d.number, passengerIndex: d.passengerIndex })) } : {}),
    ...(options.lockedReason !== undefined ? { lockedReason: options.lockedReason } : {}),
    ...(options.blockedReason !== undefined ? { blockedReason: options.blockedReason } : {}),
  };
  if (Object.keys(finalPatch).length > 0) store.patch(options.id, finalPatch);
  const record = store.get(options.id);
  if (!record) throw new Error('fixture missing record');
  return { ownerUserId: options.owner, record, history: store.historyFor(options.id) };
}

const TICKETED_PATH: readonly FulfilmentStatus[] = ['authorised', 'order_pending', 'ticketed'];

describe('access', () => {
  test('a customer sees only their own bookings in the dashboard', () => {
    const a1 = book({ id: 'A1', owner: ALICE, path: ['authorised'] });
    const b1 = book({ id: 'B1', owner: BOB, path: ['authorised'] });
    const dash = customerDashboard(ALICE_ACTOR, [a1, b1], NOW);
    const ids = [...dash.upcoming, ...dash.past].map((v) => v.bookingId);
    assert.deepEqual(ids, ['A1']);
  });

  test('another customer\'s booking is reported as not found, not forbidden', () => {
    const a1 = book({ id: 'A1', owner: ALICE, path: TICKETED_PATH });
    assert.equal(customerBooking(BOB_ACTOR, a1), null);
    const decision = cancellationDecision(BOB_ACTOR, a1);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'Booking not found.');
    const support = requestSupport(BOB_ACTOR, a1, 'Help', NOW);
    assert.deepEqual(support, { ok: false, reason: 'Booking not found.' });
    const cancel = requestCancellation(BOB_ACTOR, a1, NOW);
    assert.equal(cancel.ok, false);
  });

  test('operations functions refuse a customer actor', () => {
    const a1 = book({ id: 'A1', owner: ALICE, path: TICKETED_PATH });
    assert.throws(() => searchBookings(ALICE_ACTOR, { bookingId: 'A1' }, [a1]), AccessDeniedError);
    assert.throws(() => holdWatch(ALICE_ACTOR, [a1], NOW), AccessDeniedError);
    assert.throws(() => needsAttention(ALICE_ACTOR, [a1], NOW), AccessDeniedError);
    assert.throws(() => investigate(ALICE_ACTOR, a1, [], NOW), AccessDeniedError);
  });

  test('support and admin can use the operations views', () => {
    const a1 = book({ id: 'A1', owner: ALICE, path: TICKETED_PATH });
    assert.equal(searchBookings(SUPPORT, { bookingId: 'A1' }, [a1]).length, 1);
    assert.equal(searchBookings(ADMIN, { bookingId: 'A1' }, [a1]).length, 1);
  });

  test('a search needs at least one criterion and a surname of two or more characters', () => {
    const a1 = book({ id: 'A1', owner: ALICE });
    assert.throws(() => searchBookings(SUPPORT, {}, [a1]), RangeError);
    assert.throws(() => searchBookings(SUPPORT, { passengerSurname: 'o' }, [a1]), RangeError);
    assert.equal(searchBookings(SUPPORT, { passengerSurname: 'okafor' }, [a1]).length, 1);
  });

  test('search results are capped', () => {
    const many = Array.from({ length: SEARCH_LIMIT + 5 }, (_, i) => book({ id: `M${i}`, owner: ALICE, passengers: [{ type: 'adult', firstName: 'Ada', lastName: 'Okafor', dateOfBirth: '1990-05-14', nationality: 'NG' }] }));
    assert.equal(searchBookings(SUPPORT, { passengerSurname: 'Okafor' }, many).length, SEARCH_LIMIT);
  });
});

describe('customer privacy', () => {
  test('customer passenger view shows names only, never date of birth or nationality', () => {
    const a1 = book({ id: 'A1', owner: ALICE, path: TICKETED_PATH });
    const view = customerBooking(ALICE_ACTOR, a1);
    assert.ok(view);
    assert.deepEqual(view.passengers, [{ index: 0, name: 'Ada Okafor' }]);
    const json = JSON.stringify(view);
    assert.ok(!json.includes('1990-05-14'));
    assert.ok(!json.includes('"NG"'));
  });

  test('ticket numbers are hidden until the supplier has issued them', () => {
    const pending = book({ id: 'A1', owner: ALICE, path: ['authorised', 'order_pending'] });
    assert.deepEqual(customerBooking(ALICE_ACTOR, pending)?.tickets, []);
    const ticketed = book({ id: 'A2', owner: ALICE, path: TICKETED_PATH, documents: [{ passengerIndex: 0, number: '0011234567890' }] });
    assert.deepEqual(customerBooking(ALICE_ACTOR, ticketed)?.tickets, [{ passengerIndex: 0, number: '0011234567890' }]);
  });

  test('internal reasons are never shown to the customer', () => {
    const a1 = book({ id: 'A1', owner: ALICE, path: ['authorised', 'order_pending', 'ticketing_pending'], lockedReason: 'INTERNAL-LOCK-TEXT', blockedReason: 'INTERNAL-BLOCK-TEXT' });
    const json = JSON.stringify(customerBooking(ALICE_ACTOR, a1));
    assert.ok(!json.includes('INTERNAL-LOCK-TEXT'));
    assert.ok(!json.includes('INTERNAL-BLOCK-TEXT'));
  });

  test('an unknown fare refund rule is shown as not confirmed, never as no', () => {
    const a1 = book({ id: 'A1', owner: ALICE, path: ['authorised'] });
    const withUnknown: PortalBooking = { ...a1, record: { ...a1.record, offer: { ...a1.record.offer, fare: { checkedBags: null, cabinBags: null, refundable: null, changeable: null, restrictions: [] } } } };
    assert.equal(customerBooking(ALICE_ACTOR, withUnknown)?.refundable, 'not_confirmed');
    assert.equal(customerBooking(ALICE_ACTOR, a1)?.refundable, 'no');
  });

  test('staff investigation masks ticket numbers to the last four digits', () => {
    const a1 = book({ id: 'A1', owner: ALICE, path: TICKETED_PATH, documents: [{ passengerIndex: 0, number: '0011234567890' }] });
    const inv = investigate(SUPPORT, a1, [], NOW);
    assert.deepEqual(inv.tickets, [{ passengerIndex: 0, number: '•••7890' }]);
    assert.equal(inv.passengers[0].dateOfBirth, '1990-05-14');
  });
});

describe('status wording', () => {
  test('every fulfilment status has exactly one category and a label', () => {
    for (const status of ALL_STATUSES) {
      assert.ok(displayCategory(status));
      assert.ok(categoryLabel(status).length > 0);
    }
  });

  test('only the confirmed status is labelled Confirmed', () => {
    for (const status of ALL_STATUSES) {
      if (status === 'confirmed') continue;
      assert.notEqual(categoryLabel(status), 'Confirmed', `${status} must not be labelled Confirmed`);
    }
    assert.equal(categoryLabel('confirmed'), 'Confirmed');
  });

  test('tickets issued without captured payment are not described as confirmed', () => {
    const ticketed = book({ id: 'A1', owner: ALICE, path: TICKETED_PATH, documents: [{ passengerIndex: 0, number: '0011234567890' }] });
    const view = customerBooking(ALICE_ACTOR, ticketed);
    assert.equal(view?.category, 'ticketed');
    assert.equal(view?.categoryLabel, 'Tickets issued');
    assert.ok(!/confirmed/i.test(view?.headline ?? ''));
  });

  test('expired and failed bookings are grouped as not completed', () => {
    assert.equal(displayCategory('expired'), 'failed');
    assert.equal(displayCategory('failed'), 'failed');
  });

  test('refund pending and refunded keep their own categories', () => {
    assert.equal(displayCategory('refund_pending'), 'refund_pending');
    assert.equal(displayCategory('refunded'), 'refunded');
    assert.equal(displayCategory('cancelled'), 'cancelled');
  });

  test('a status with unknown outcome is shown as needing checking, not as pending', () => {
    assert.equal(displayCategory('order_unknown'), 'attention');
    assert.equal(displayCategory('ticketing_unknown'), 'attention');
    assert.equal(customerStatus('order_unknown').showTickets, false);
  });
});

describe('timelines', () => {
  test('timeline entries are sorted by time, and entries without a time come first and are not invented', () => {
    const a1 = book({ id: 'A1', owner: ALICE, path: ['authorised', 'order_pending'], at: ['2026-11-13T08:10:00Z', '2026-11-13T08:20:00Z'] });
    const paymentAudit: AuditEntry[] = [
      { at: '2026-11-13T08:15:00Z', intentId: 'intent-A1', event: 'payment_authorised', from: 'initiated', to: 'authorised', detail: 'Payment authorised by provider.' },
    ];
    const items = buildTimeline(a1.history, paymentAudit);
    assert.equal(items[0].at, null, 'creation has no recorded time');
    assert.deepEqual(items.slice(1).map((i) => i.at), ['2026-11-13T08:10:00Z', '2026-11-13T08:15:00Z', '2026-11-13T08:20:00Z']);
    assert.equal(items.filter((i) => i.source === 'payment').length, 1);
  });

  test('the customer timeline shows status labels only, with no payment entries', () => {
    const a1 = book({ id: 'A1', owner: ALICE, path: ['authorised', 'order_pending'], at: ['2026-11-13T08:10:00Z', '2026-11-13T08:20:00Z'] });
    const items = customerTimeline(a1.history);
    assert.ok(items.every((i) => typeof i.label === 'string'));
    assert.ok(items.some((i) => i.label === 'Pending'));
    assert.ok(!JSON.stringify(items).includes('payment'));
  });

  test('lastChangedAt is null when no time was recorded', () => {
    const a1 = book({ id: 'A1', owner: ALICE, path: ['authorised'] });
    assert.equal(lastChangedAt(a1.history), null);
  });
});

describe('dashboard split', () => {
  test('upcoming and past trips are separated and ordered', () => {
    const future = book({ id: 'F1', owner: ALICE, path: ['authorised'], withReturn: true });
    const past = book({ id: 'P1', owner: ALICE, path: ['authorised'], past: true, holdExpiresAtUtc: '2026-10-01T00:00:00Z' });
    const dash = customerDashboard(ALICE_ACTOR, [past, future], NOW);
    assert.deepEqual(dash.upcoming.map((v) => v.bookingId), ['F1']);
    assert.deepEqual(dash.past.map((v) => v.bookingId), ['P1']);
    assert.equal(dash.upcoming[0].itinerary.length, 2, 'return legs are shown');
    assert.equal(dash.upcoming[0].itinerary[1].leg, 'return');
  });
});

describe('customer requests', () => {
  test('cancellation is allowed for an owner whose booking has a supplier order', () => {
    const ticketed = book({ id: 'A1', owner: ALICE, path: TICKETED_PATH });
    assert.equal(cancellationDecision(ALICE_ACTOR, ticketed).allowed, true);
  });

  test('cancellation is refused with a reason for each state where it does not apply', () => {
    const held = book({ id: 'H1', owner: ALICE, path: [] });
    assert.equal(cancellationDecision(ALICE_ACTOR, held).allowed, false);
    const unknown = book({ id: 'U1', owner: ALICE, path: ['authorised', 'order_unknown'] });
    assert.equal(cancellationDecision(ALICE_ACTOR, unknown).allowed, false);
    assert.match(cancellationDecision(ALICE_ACTOR, unknown).reason, /checking/);
    const cancelled = book({ id: 'C1', owner: ALICE, path: [...TICKETED_PATH, 'cancellation_pending', 'cancelled'] });
    assert.equal(cancellationDecision(ALICE_ACTOR, cancelled).allowed, false);
  });

  test('a cancellation request is recorded for staff and does not change the booking', () => {
    const ticketed = book({ id: 'A1', owner: ALICE, path: TICKETED_PATH });
    const result = requestCancellation(ALICE_ACTOR, ticketed, NOW);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.request.kind, 'cancellation');
    assert.equal(result.request.state, 'open');
    assert.equal(result.audit.action, 'booking.cancellation_requested');
    assert.equal(ticketed.record.status, 'ticketed', 'a request does not change status');
  });

  test('support requests are trimmed and limited in length', () => {
    const a1 = book({ id: 'A1', owner: ALICE, path: TICKETED_PATH });
    assert.equal(requestSupport(ALICE_ACTOR, a1, '   ', NOW).ok, false);
    assert.equal(requestSupport(ALICE_ACTOR, a1, 'x'.repeat(SUPPORT_MESSAGE_MAX + 1), NOW).ok, false);
    const ok = requestSupport(ALICE_ACTOR, a1, '  My name is spelled wrong  ', NOW);
    assert.equal(ok.ok && ok.request.message, 'My name is spelled wrong');
  });
});

describe('operations watch lists', () => {
  test('hold watch lists unordered holds soonest first, with expiry state', () => {
    const soon = book({ id: 'S1', owner: ALICE, path: ['authorised'], holdExpiresAtUtc: '2026-11-13T09:05:00Z' });
    const later = book({ id: 'L1', owner: ALICE, path: ['authorised'], holdExpiresAtUtc: '2026-11-13T10:00:00Z' });
    const lapsed = book({ id: 'X1', owner: ALICE, path: ['authorised'], holdExpiresAtUtc: '2026-11-13T08:59:00Z' });
    const ticketed = book({ id: 'T1', owner: ALICE, path: TICKETED_PATH });
    const items = holdWatch(SUPPORT, [later, soon, lapsed, ticketed], NOW);
    assert.deepEqual(items.map((i) => i.bookingId), ['X1', 'S1', 'L1']);
    assert.deepEqual(items.map((i) => i.expiry), ['expired', 'expiring_soon', 'active']);
  });

  test('attention list flags unknown and partial outcomes as high severity', () => {
    const unknown = book({ id: 'U1', owner: ALICE, path: ['authorised', 'order_unknown'], at: [null, '2026-11-13T08:00:00Z'] });
    const partial = book({ id: 'P1', owner: ALICE, path: ['authorised', 'order_pending', 'partially_fulfilled'] });
    const items = needsAttention(SUPPORT, [partial, unknown], NOW);
    assert.equal(items[0].severity, 'high');
    assert.ok(items.some((i) => i.bookingId === 'U1' && i.severity === 'high'));
    assert.ok(items.some((i) => i.bookingId === 'P1' && i.severity === 'high'));
  });

  test('in-flight bookings with no change for a long time are flagged as delayed', () => {
    const stale = book({ id: 'D1', owner: ALICE, path: ['authorised', 'order_pending'], at: ['2026-11-13T07:00:00Z', '2026-11-13T07:05:00Z'] });
    const fresh = book({ id: 'D2', owner: ALICE, path: ['authorised', 'order_pending'], at: ['2026-11-13T08:50:00Z', '2026-11-13T08:55:00Z'] });
    const items = needsAttention(SUPPORT, [stale, fresh], NOW);
    const d1 = items.find((i) => i.bookingId === 'D1');
    assert.ok(d1);
    assert.equal(d1.severity, 'medium');
    assert.match(d1.reasons.join(' '), /No change for \d+ minutes/);
    assert.ok(!items.some((i) => i.bookingId === 'D2'));
  });

  test('an in-flight booking with no recorded change time is flagged, not assumed fresh', () => {
    const undated = book({ id: 'N1', owner: ALICE, path: ['authorised', 'order_pending'] });
    const item = needsAttention(SUPPORT, [undated], NOW)[0];
    assert.ok(item);
    assert.match(item.reasons.join(' '), /No change time is recorded/);
  });

  test('ticketed and confirmed bookings are not listed for attention', () => {
    const ticketed = book({ id: 'T1', owner: ALICE, path: TICKETED_PATH, documents: [{ passengerIndex: 0, number: '0011234567890' }] });
    assert.deepEqual(needsAttention(SUPPORT, [ticketed], NOW), []);
  });
});

describe('notifications', () => {
  test('a ticket-issued message is generated only when the supplier has issued documents', () => {
    const noDocs = book({ id: 'A1', owner: ALICE, path: TICKETED_PATH });
    assert.equal(ticketIssuedMessage(noDocs, NOW), null);
    const docs = book({ id: 'A2', owner: ALICE, path: TICKETED_PATH, documents: [{ passengerIndex: 0, number: '0011234567890' }] });
    const msg = ticketIssuedMessage(docs, NOW);
    assert.ok(msg);
    assert.equal(msg.recipientUserId, ALICE);
    assert.ok(!msg.body.includes('0011234567890'), 'ticket numbers never appear in email');
  });

  test('customer email never contains passenger names', () => {
    const a1 = book({ id: 'A1', owner: ALICE, path: ['authorised', 'order_pending'] });
    const msg = bookingUpdateMessage(a1, NOW);
    assert.ok(!msg.body.includes('Okafor'));
    assert.ok(!msg.subject.includes('Okafor'));
  });

  test('cancellation messages are only generated for cancellation states', () => {
    const ticketed = book({ id: 'A1', owner: ALICE, path: TICKETED_PATH });
    assert.equal(cancellationMessage(ticketed, NOW), null);
    const refunded = book({ id: 'A2', owner: ALICE, path: [...TICKETED_PATH, 'cancellation_pending', 'cancelled', 'refund_pending'] });
    assert.ok(cancellationMessage(refunded, NOW));
  });

  test('payment messages say nothing for states without safe wording', () => {
    const a1 = book({ id: 'A1', owner: ALICE, path: ['authorised'] });
    assert.equal(paymentStatusMessage(a1, 'review_required', NOW), null);
    assert.ok(paymentStatusMessage(a1, 'captured', NOW));
  });

  test('operational problem messages go to staff, with no passenger detail', () => {
    const a1 = book({ id: 'A1', owner: ALICE, path: ['authorised', 'order_unknown'] });
    const msg = operationalProblemMessage(a1, ['The supplier outcome is unknown.'], NOW);
    assert.equal(msg.audience, 'staff');
    assert.equal(msg.recipientUserId, null);
    assert.ok(!msg.body.includes('Okafor'));
  });

  test('a delivered message is sent once and not again on repeat dispatch', async () => {
    const adapter = new RecordingAdapter();
    const outbox = new Outbox();
    const a1 = book({ id: 'A1', owner: ALICE, path: ['authorised'] });
    const msg = bookingUpdateMessage(a1, NOW);
    const first = await outbox.dispatch(adapter, msg);
    const second = await outbox.dispatch(adapter, msg);
    assert.equal(first.state, 'sent');
    assert.equal(second.state, 'sent');
    assert.equal(adapter.sent.length, 1);
  });

  test('a failed delivery is recorded as failed, does not change the booking, and can be retried', async () => {
    const adapter = new RecordingAdapter();
    const outbox = new Outbox();
    const a1 = book({ id: 'A1', owner: ALICE, path: ['authorised'] });
    const msg = bookingUpdateMessage(a1, NOW);
    adapter.failNext = 'temporary';
    const failed = await outbox.dispatch(adapter, msg);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.reason, 'temporary');
    assert.equal(a1.record.status, 'authorised');
    const retried = await outbox.dispatch(adapter, msg);
    assert.equal(retried.state, 'sent');
    assert.equal(retried.attempts, 2);
    assert.equal(adapter.sent.length, 1);
  });

  test('an adapter that throws is recorded as provider_error, without storing its message', async () => {
    const throwing: NotificationAdapter = {
      name: 'throwing',
      async send(): Promise<never> {
        throw new Error('smtp auth failed for ada@example.com');
      },
    };
    const outbox = new Outbox();
    const a1 = book({ id: 'A1', owner: ALICE, path: ['authorised'] });
    const entry = await outbox.dispatch(throwing, bookingUpdateMessage(a1, NOW));
    assert.equal(entry.state, 'failed');
    assert.equal(entry.reason, 'provider_error');
    assert.ok(!JSON.stringify(entry).includes('ada@example.com'));
  });

  test('the default email adapter never sends and reports not configured', async () => {
    const outbox = new Outbox();
    const a1 = book({ id: 'A1', owner: ALICE, path: ['authorised'] });
    const entry = await outbox.dispatch(new UnconfiguredEmailAdapter(), bookingUpdateMessage(a1, NOW));
    assert.equal(entry.state, 'not_configured');
    assert.equal(entry.providerMessageId, null);
  });

  test('messages carry no email address', () => {
    const a1 = book({ id: 'A1', owner: ALICE, path: ['authorised'] });
    const msg: OutboundMessage = bookingUpdateMessage(a1, NOW);
    assert.ok(!JSON.stringify(msg).includes('@'));
  });
});
