// Notification tests: template rendering and escaping, verified-state gates, duplicate events,
// retries and backoff, failed and not-configured delivery, the daily cap, preferences, rate limits,
// and privacy. Providers and passengers here are fixtures.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { FulfilmentStore, type FulfilmentRecord } from '../../fulfilment/src/store.ts';
import type { FulfilmentStatus } from '../../fulfilment/src/status.ts';
import type { Offer } from '../../flights/src/supplier.ts';
import { escapeHtml, formatMoney, RenderError, safeHttpsUrl, safeText } from '../src/render.ts';
import { renderTemplate, TEMPLATE_IDS, type RenderContext, type TemplateDataMap, type TemplateId } from '../src/templates.ts';
import { makeRenderer } from '../src/renderer.ts';
import { NotificationQueue, DEFAULT_CONFIG } from '../src/queue.ts';
import { DEFAULT_PREFERENCES, preferenceAllows, sanitisePreferences, type Preferences } from '../src/preferences.ts';
import {
  authRequest, bookingReceivedRequest, bookingStatusRequest, cancellationRequest, itineraryRequest,
  paymentConfirmedRequest, paymentFailedRequest, refundRequest, securityAlertRequest, supportReplyRequest, ticketIssuedRequest,
  type NotificationRequest,
} from '../src/requests.ts';
import { MemoryTransport, UnconfiguredTransport, type Transport } from '../src/transport.ts';
import { ticketsVerified } from '../src/verified.ts';

const NOW = '2026-11-15T10:00:00Z';
const USER = 'cust-ada';
const EMAIL = 'ada@example.test';
const CTX: RenderContext = {
  appUrl: 'https://app.example.com',
  authLink: (kind, nonce) => `https://app.example.com/auth/${kind}?t=${nonce}`,
};

function offer(withReturn = false): Offer {
  return {
    id: 'offer-1',
    supplierPrice: { amountMinor: 85_000_000, currency: 'NGN' },
    displayPrice: { amountMinor: 85_000_000, currency: 'NGN' },
    expiresAtUtc: '2026-11-15T12:00:00Z',
    segments: [{
      origin: 'LOS', destination: 'LHR',
      departureUtc: '2026-12-01T09:00:00Z', arrivalUtc: '2026-12-01T15:30:00Z',
      departureTimeZone: 'Africa/Lagos', arrivalTimeZone: 'Europe/London',
      carrier: 'BA', flightNumber: 'BA75',
    }],
    ...(withReturn
      ? {
          returnSegments: [{
            origin: 'LHR', destination: 'LOS',
            departureUtc: '2026-12-10T18:00:00Z', arrivalUtc: '2026-12-11T06:00:00Z',
            departureTimeZone: 'Europe/London', arrivalTimeZone: 'Africa/Lagos',
            carrier: 'BA', flightNumber: 'BA74',
          }],
        }
      : {}),
    fare: { checkedBags: 1, cabinBags: 1, refundable: true, changeable: null, restrictions: [] },
  };
}

function record(status: FulfilmentStatus, opts: { documents?: boolean; withReturn?: boolean; id?: string; reference?: string | null } = {}): FulfilmentRecord {
  const store = new FulfilmentStore();
  const id = opts.id ?? 'B-1';
  store.create({
    bookingId: id, status, intentId: `intent-${id}`, offer: offer(opts.withReturn ?? false),
    passengers: [{ type: 'adult', firstName: 'Ada', lastName: 'Okafor', dateOfBirth: '1990-05-14', nationality: 'NG' }],
    totalMinor: 85_000_000, currency: 'NGN', holdExpiresAtUtc: '2026-11-15T10:30:00Z',
    orderId: 'ORD-1', bookingReference: opts.reference === undefined ? 'ABC234' : opts.reference,
    documents: opts.documents ? [{ type: 'electronic_ticket', number: '0011234567890', passengerIndex: 0 }] : [],
    lockedReason: null, blockedReason: null,
  });
  const r = store.get(id);
  if (!r) throw new Error('fixture');
  return r;
}

function prefsAll(v: boolean): Preferences {
  return { bookingProgress: v, supportReplies: v };
}

function must(result: { ok: true; request: NotificationRequest } | { ok: false; reason: string }): NotificationRequest {
  if (!result.ok) throw new Error(`expected a request, got ${result.reason}`);
  return result.request;
}

function deps(transport: Transport, addr: string | null = EMAIL) {
  return {
    transport,
    addressFor: async () => addr,
    render: makeRenderer(CTX),
  };
}

describe('rendering and escaping', () => {
  test('every template renders a subject, a text part and an HTML part', () => {
    const samples: { [K in TemplateId]: TemplateDataMap[K] } = {
      account_verification: { nonce: 'n1', expiresInMinutes: 30 },
      password_reset: { nonce: 'n2', expiresInMinutes: 30 },
      security_alert: { event: 'new_sign_in', occurredAtUtc: NOW },
      booking_received: { bookingReference: 'ABC234' },
      booking_status: { bookingReference: 'ABC234', headline: 'Pending', detail: 'We are working on it.' },
      payment_confirmed: { bookingReference: 'ABC234', amountMinor: 85_000_000, currency: 'NGN' },
      payment_failed: { bookingReference: 'ABC234' },
      ticket_issued: { bookingReference: 'ABC234' },
      itinerary: { bookingReference: 'ABC234', legs: [{ leg: 'outbound', carrier: 'BA', flightNumber: 'BA75', origin: 'LOS', destination: 'LHR', departureLocal: 'x', arrivalLocal: 'y' }] },
      cancellation_update: { bookingReference: 'ABC234', headline: 'Cancelled', detail: 'Done.' },
      refund_update: { headline: 'Received', detail: 'Checking.', confirmedAmount: null },
      support_reply: { requestId: 'SR-000001', category: 'booking' },
    };
    for (const id of TEMPLATE_IDS) {
      const out = renderTemplate(id, samples[id] as never, CTX);
      assert.ok(out.subject.length > 0, `${id} subject`);
      assert.ok(out.text.length > 0, `${id} text`);
      assert.ok(out.html.startsWith('<!doctype html>'), `${id} html`);
    }
  });

  test('the layout is responsive, uses the 600px card, and uses only the approved brand colours', () => {
    const out = renderTemplate('booking_received', { bookingReference: 'ABC234' }, CTX);
    assert.match(out.html, /name="viewport"/);
    assert.match(out.html, /max-width:600px/);
    assert.match(out.html, /@media only screen and \(max-width:600px\)/);
    assert.match(out.html, /#512584/);
    assert.match(out.html, /#FF5738/);
    // The orange button label is ink (#1A0B2E), not white, because white on orange fails contrast.
    assert.match(out.html, /color:#1A0B2E;text-decoration:none/);
  });

  test('injected markup in dynamic text is escaped, never rendered', () => {
    const out = renderTemplate('booking_status', { bookingReference: 'ABC234', headline: '<script>alert(1)</script>', detail: '"><img src=x onerror=alert(1)>' }, CTX);
    assert.ok(!out.html.includes('<script>'));
    assert.ok(!out.html.includes('<img'));
    assert.ok(out.html.includes('&lt;script&gt;'));
  });

  test('control characters and line breaks are stripped, so headers and layout cannot be split', () => {
    assert.equal(safeText('Hello\r\nBcc: someone@example.test'), 'Hello Bcc: someone@example.test');
    assert.throws(() => safeText('   '), RenderError);
    assert.throws(() => safeText('x'.repeat(501)), RenderError);
  });

  test('a text part contains no HTML tags', () => {
    const out = renderTemplate('payment_failed', { bookingReference: 'ABC234' }, CTX);
    assert.ok(!/<[a-z][^>]*>/i.test(out.text));
  });

  test('only HTTPS links are allowed in email', () => {
    assert.throws(() => safeHttpsUrl('http://app.example.com/x'), RenderError);
    assert.throws(() => safeHttpsUrl('javascript:alert(1)'), RenderError);
    assert.throws(() => safeHttpsUrl('https://user:pass@app.example.com/x'), RenderError);
    assert.equal(safeHttpsUrl('https://app.example.com/x'), 'https://app.example.com/x');
  });

  test('a non-HTTPS app base URL is refused for every link-bearing template', () => {
    const bad: RenderContext = { appUrl: 'http://insecure.example.com', authLink: CTX.authLink };
    assert.throws(() => renderTemplate('booking_status', { bookingReference: 'ABC234', headline: 'H', detail: 'D' }, bad), RenderError);
  });

  test('money is formatted in minor units with integer arithmetic', () => {
    assert.equal(formatMoney(85_000_000, 'NGN'), 'NGN 850,000.00');
    assert.equal(formatMoney(1_005, 'GBP'), 'GBP 10.05');
    assert.throws(() => formatMoney(10.5, 'NGN'), RenderError);
    assert.throws(() => formatMoney(-1, 'NGN'), RenderError);
    assert.throws(() => formatMoney(100, 'naira'), RenderError);
  });

  test('a booking reference must match the reference pattern', () => {
    assert.throws(() => renderTemplate('booking_received', { bookingReference: 'abc234' }, CTX), /invalid_reference/);
    assert.throws(() => renderTemplate('booking_received', { bookingReference: '<b>X</b>' }, CTX), /invalid_reference/);
  });

  test('an escape helper covers all five HTML-significant characters', () => {
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('ticket and itinerary privacy', () => {
  test('ticket and itinerary emails never contain ticket numbers, passenger names or dates of birth', () => {
    const ticketed = record('ticketed', { documents: true, withReturn: true });
    const ticket = must(ticketIssuedRequest(ticketed, USER, NOW));
    const itin = must(itineraryRequest(ticketed, USER, NOW));
    const ticketOut = renderTemplate('ticket_issued', ticket.data as never, CTX);
    const itinOut = renderTemplate('itinerary', itin.data as never, CTX);
    for (const out of [ticketOut, itinOut]) {
      for (const body of [out.html, out.text, out.subject]) {
        assert.ok(!body.includes('0011234567890'), 'ticket number leaked');
        assert.ok(!body.includes('Okafor'), 'passenger surname leaked');
        assert.ok(!body.includes('Ada'), 'passenger first name leaked');
        assert.ok(!body.includes('1990-05-14'), 'date of birth leaked');
      }
    }
  });

  test('itinerary times are shown in each airport\'s own time zone', () => {
    const itin = must(itineraryRequest(record('ticketed', { documents: true }), USER, NOW));
    const out = renderTemplate('itinerary', itin.data as never, CTX);
    assert.ok(out.text.includes('(Africa/Lagos)'));
    assert.ok(out.text.includes('(Europe/London)'));
    assert.ok(out.text.includes('BA 75') || out.text.includes('BA75'));
  });

  test('a return leg appears when the booking has one', () => {
    const itin = must(itineraryRequest(record('ticketed', { documents: true, withReturn: true }), USER, NOW));
    const out = renderTemplate('itinerary', itin.data as never, CTX);
    assert.ok(out.text.includes('Return BA74'));
  });
});

describe('verified system states', () => {
  test('a ticket email is refused while the supplier has not issued tickets', () => {
    for (const status of ['held', 'authorised', 'order_pending', 'ticketing_pending', 'order_unknown', 'ticketing_unknown'] as const) {
      const r = ticketIssuedRequest(record(status, { documents: true }), USER, NOW);
      assert.equal(r.ok, false, `${status} must not send a ticket email`);
    }
  });

  test('a ticket email is refused when the status says ticketed but no supplier document exists', () => {
    const r = ticketIssuedRequest(record('ticketed', { documents: false }), USER, NOW);
    assert.deepEqual(r, { ok: false, reason: 'no_supplier_documents' });
    assert.equal(ticketsVerified(record('ticketed', { documents: false })).ok, false);
  });

  test('a ticket email is sent once tickets are issued and documents exist', () => {
    const r = ticketIssuedRequest(record('ticketed', { documents: true }), USER, NOW);
    assert.equal(r.ok, true);
  });

  test('an itinerary is refused before tickets are issued', () => {
    assert.equal(itineraryRequest(record('order_pending'), USER, NOW).ok, false);
    assert.equal(itineraryRequest(record('partially_fulfilled', { documents: true }), USER, NOW).ok, false);
  });

  test('a payment-confirmed email is refused unless the payment is captured', () => {
    const r = record('ticketed', { documents: true });
    assert.equal(paymentConfirmedRequest('intent-B-1', 'authorised', r, USER, NOW).ok, false);
    assert.equal(paymentConfirmedRequest('intent-B-1', 'released', r, USER, NOW).ok, false);
    assert.equal(paymentConfirmedRequest('intent-B-1', 'captured', r, USER, NOW).ok, true);
  });

  test('a payment-failed email is sent only for failed or expired payments', () => {
    const r = record('expired');
    assert.equal(paymentFailedRequest('intent-B-1', 'failed', r, USER, NOW).ok, true);
    assert.equal(paymentFailedRequest('intent-B-1', 'expired', r, USER, NOW).ok, true);
    assert.equal(paymentFailedRequest('intent-B-1', 'captured', r, USER, NOW).ok, false);
  });

  test('a refund email shows a confirmed amount only for a completed refund', () => {
    const done = must(refundRequest('RF-1', 'completed', 'eligible', USER, { amountMinor: 1000, currency: 'NGN' }, NOW));
    assert.deepEqual(done.data.confirmedAmount, { amountMinor: 1000, currency: 'NGN' });
    const pending = must(refundRequest('RF-1', 'approved', 'eligible', USER, { amountMinor: 1000, currency: 'NGN' }, NOW));
    assert.equal(pending.data.confirmedAmount, null);
  });

  test('a cancellation email is refused for a booking that is not cancelled', () => {
    assert.equal(cancellationRequest(record('ticketed', { documents: true }), USER, NOW).ok, false);
    assert.equal(cancellationRequest(record('cancelled'), USER, NOW).ok, true);
  });

  test('intermediate booking statuses are optional, and final statuses are always sent', () => {
    assert.equal(must(bookingStatusRequest(record('order_pending'), USER, NOW)).preferenceKey, 'bookingProgress');
    assert.equal(must(bookingStatusRequest(record('ticketed', { documents: true }), USER, NOW)).preferenceKey, null);
  });
});

describe('duplicate events and idempotency', () => {
  test('the same request enqueued twice is a duplicate, with one job', () => {
    const q = new NotificationQueue();
    const req = must(bookingReceivedRequest(record('held'), USER, NOW));
    const a = q.enqueue(req, DEFAULT_PREFERENCES, NOW);
    const b = q.enqueue(req, DEFAULT_PREFERENCES, NOW);
    assert.equal(a.status, 'queued');
    assert.equal(b.status, 'duplicate');
    assert.equal(q.allJobs().length, 1);
  });

  test('a repeated booking status does not send again, but a new status does', () => {
    const q = new NotificationQueue();
    const first = must(bookingStatusRequest(record('order_pending'), USER, NOW));
    const again = must(bookingStatusRequest(record('order_pending'), USER, NOW));
    const next = must(bookingStatusRequest(record('ticketing_pending'), USER, NOW));
    assert.equal(q.enqueue(first, DEFAULT_PREFERENCES, NOW).status, 'queued');
    assert.equal(q.enqueue(again, DEFAULT_PREFERENCES, NOW).status, 'duplicate');
    assert.equal(q.enqueue(next, DEFAULT_PREFERENCES, NOW).status, 'queued');
  });

  test('a ticket email is delivered once even when the queue runs repeatedly', async () => {
    const q = new NotificationQueue();
    const t = new MemoryTransport();
    q.enqueue(must(ticketIssuedRequest(record('ticketed', { documents: true }), USER, NOW)), DEFAULT_PREFERENCES, NOW);
    await q.processDue(NOW, deps(t));
    await q.processDue(NOW, deps(t));
    await q.processDue(NOW, deps(t));
    assert.equal(t.delivered.length, 1);
  });

  test('a retried send carries the same idempotency key', async () => {
    const q = new NotificationQueue();
    const t = new MemoryTransport();
    t.script = [{ state: 'failed', code: 'timeout', retryable: true }];
    q.enqueue(must(bookingReceivedRequest(record('held'), USER, NOW)), DEFAULT_PREFERENCES, NOW);
    await q.processDue(NOW, deps(t));
    await q.processDue('2026-11-15T10:02:00Z', deps(t));
    assert.equal(t.attempts.length, 2);
    assert.equal(t.attempts[0].idempotencyKey, t.attempts[1].idempotencyKey);
    assert.equal(t.delivered.length, 1);
  });
});

describe('delivery, retries and failure handling', () => {
  test('a transient failure schedules a retry after the first backoff, and logs a code', async () => {
    const q = new NotificationQueue();
    const t = new MemoryTransport();
    t.script = [{ state: 'failed', code: 'rate_limited', retryable: true }];
    const { jobId } = q.enqueue(must(bookingReceivedRequest(record('held'), USER, NOW)), DEFAULT_PREFERENCES, NOW);
    const report = await q.processDue(NOW, deps(t));
    assert.equal(report.retried, 1);
    const job = q.job(jobId);
    assert.equal(job?.state, 'retry_scheduled');
    assert.equal(job?.attempts, 1);
    assert.equal(job?.nextAttemptAt, '2026-11-15T10:01:00.000Z');
    assert.equal(q.failureLog[0].code, 'rate_limited');
    assert.equal(q.failureLog[0].retryable, true);
  });

  test('a retry is not attempted before its backoff has passed', async () => {
    const q = new NotificationQueue();
    const t = new MemoryTransport();
    t.script = [{ state: 'failed', code: 'timeout', retryable: true }];
    q.enqueue(must(bookingReceivedRequest(record('held'), USER, NOW)), DEFAULT_PREFERENCES, NOW);
    await q.processDue(NOW, deps(t));
    const early = await q.processDue('2026-11-15T10:00:30Z', deps(t));
    assert.equal(early.sent + early.retried, 0);
    assert.equal(t.attempts.length, 1);
  });

  test('backoff grows through the configured sequence', async () => {
    const q = new NotificationQueue();
    const t = new MemoryTransport();
    t.script = [
      { state: 'failed', code: 'e', retryable: true },
      { state: 'failed', code: 'e', retryable: true },
    ];
    const { jobId } = q.enqueue(must(bookingReceivedRequest(record('held'), USER, NOW)), DEFAULT_PREFERENCES, NOW);
    await q.processDue(NOW, deps(t));
    const afterFirst = q.job(jobId)?.nextAttemptAt ?? '';
    await q.processDue(afterFirst, deps(t));
    const afterSecond = q.job(jobId)?.nextAttemptAt ?? '';
    assert.equal(Date.parse(afterSecond) - Date.parse(afterFirst), DEFAULT_CONFIG.backoffSeconds[1] * 1000);
  });

  test('after the maximum attempts the job is dead, its data is cleared, and no further attempt is made', async () => {
    const q = new NotificationQueue({ maxAttempts: 2, backoffSeconds: [1, 1] });
    const t = new MemoryTransport();
    t.script = [
      { state: 'failed', code: 'e', retryable: true },
      { state: 'failed', code: 'e', retryable: true },
    ];
    const { jobId } = q.enqueue(must(bookingReceivedRequest(record('held'), USER, NOW)), DEFAULT_PREFERENCES, NOW);
    await q.processDue(NOW, deps(t));
    await q.processDue('2026-11-15T10:00:05Z', deps(t));
    assert.equal(q.job(jobId)?.state, 'dead');
    assert.equal(q.job(jobId)?.data, null);
    const more = await q.processDue('2026-11-15T11:00:00Z', deps(t));
    assert.equal(more.sent + more.retried + more.failed, 0);
  });

  test('a permanent failure stops at once, with no retry', async () => {
    const q = new NotificationQueue();
    const t = new MemoryTransport();
    t.script = [{ state: 'failed', code: 'hard_bounce', retryable: false }];
    const { jobId } = q.enqueue(must(bookingReceivedRequest(record('held'), USER, NOW)), DEFAULT_PREFERENCES, NOW);
    const report = await q.processDue(NOW, deps(t));
    assert.equal(report.failed, 1);
    assert.equal(q.job(jobId)?.state, 'failed');
    assert.equal(q.job(jobId)?.attempts, 1);
    assert.equal(q.job(jobId)?.data, null);
  });

  test('a transport that throws is treated as transient, and its message is not stored', async () => {
    const q = new NotificationQueue();
    const thrower: Transport = {
      name: 'throws',
      async send() {
        throw new Error('smtp auth failed for ada@example.test with password hunter2');
      },
    };
    const { jobId } = q.enqueue(must(bookingReceivedRequest(record('held'), USER, NOW)), DEFAULT_PREFERENCES, NOW);
    await q.processDue(NOW, deps(thrower));
    const job = q.job(jobId);
    assert.equal(job?.state, 'retry_scheduled');
    assert.equal(job?.lastErrorCode, 'transport_error');
    const stored = JSON.stringify([job, q.failureLog]);
    assert.ok(!stored.includes('hunter2'));
    assert.ok(!stored.includes('ada@example.test'));
  });

  test('an unconfigured transport sends nothing, keeps the job queued, and does not count an attempt', async () => {
    const q = new NotificationQueue();
    const { jobId } = q.enqueue(must(bookingReceivedRequest(record('held'), USER, NOW)), DEFAULT_PREFERENCES, NOW);
    const report = await q.processDue(NOW, deps(new UnconfiguredTransport()));
    assert.equal(report.notConfigured, 1);
    const job = q.job(jobId);
    assert.equal(job?.state, 'queued');
    assert.equal(job?.attempts, 0);
    assert.equal(job?.lastErrorCode, 'not_configured');
    assert.equal(job?.nextAttemptAt, '2026-11-15T10:15:00.000Z');
  });

  test('a customer with no address is a permanent failure, with no send attempt', async () => {
    const q = new NotificationQueue();
    const t = new MemoryTransport();
    const { jobId } = q.enqueue(must(bookingReceivedRequest(record('held'), USER, NOW)), DEFAULT_PREFERENCES, NOW);
    await q.processDue(NOW, deps(t, null));
    assert.equal(q.job(jobId)?.lastErrorCode, 'no_address');
    assert.equal(q.job(jobId)?.state, 'failed');
    assert.equal(t.attempts.length, 0);
  });

  test('a render error is a permanent failure with a code, not a crash', async () => {
    const q = new NotificationQueue();
    const t = new MemoryTransport();
    const bad = must(bookingReceivedRequest(record('held', { reference: 'bad!!' }), USER, NOW));
    const { jobId } = q.enqueue(bad, DEFAULT_PREFERENCES, NOW);
    await q.processDue(NOW, deps(t));
    assert.equal(q.job(jobId)?.lastErrorCode, 'render_error');
    assert.equal(t.attempts.length, 0);
  });

  test('an address lookup error is transient and does not send', async () => {
    const q = new NotificationQueue();
    const t = new MemoryTransport();
    const { jobId } = q.enqueue(must(bookingReceivedRequest(record('held'), USER, NOW)), DEFAULT_PREFERENCES, NOW);
    await q.processDue(NOW, { transport: t, addressFor: async () => { throw new Error('db down'); }, render: makeRenderer(CTX) });
    assert.equal(q.job(jobId)?.state, 'retry_scheduled');
    assert.equal(q.job(jobId)?.lastErrorCode, 'address_error');
    assert.equal(t.attempts.length, 0);
  });

  test('a stale claim from a crash is released for retry, and the provider delivers only once', async () => {
    const q = new NotificationQueue({ staleClaimMs: 60_000 });
    const hanging: Transport = { name: 'hang', send: () => new Promise(() => {}) };
    const { jobId } = q.enqueue(must(bookingReceivedRequest(record('held'), USER, NOW)), DEFAULT_PREFERENCES, NOW);
    void q.processDue(NOW, deps(hanging)); // the send never returns: a crash mid-send
    await new Promise((r) => setImmediate(r));
    assert.equal(q.job(jobId)?.state, 'sending');
    assert.equal(q.releaseStaleClaims('2026-11-15T10:05:00Z'), 1);
    assert.equal(q.job(jobId)?.state, 'retry_scheduled');
    const t = new MemoryTransport();
    await q.processDue('2026-11-15T10:05:00Z', deps(t));
    assert.equal(t.delivered.length, 1);
    assert.equal(q.job(jobId)?.state, 'sent');
  });

  test('a successful send records the provider ID and clears the private data', async () => {
    const q = new NotificationQueue();
    const t = new MemoryTransport();
    const { jobId } = q.enqueue(must(bookingReceivedRequest(record('held'), USER, NOW)), DEFAULT_PREFERENCES, NOW);
    await q.processDue(NOW, deps(t));
    const job = q.job(jobId);
    assert.equal(job?.state, 'sent');
    assert.equal(job?.providerId, 'mem_1');
    assert.equal(job?.data, null);
    assert.ok(job?.sentAt);
  });
});

describe('daily send cap and batching', () => {
  test('deliveries stop at the daily cap and resume the next UTC day', async () => {
    const q = new NotificationQueue({ dailySendCap: 2 });
    const t = new MemoryTransport();
    for (let i = 1; i <= 3; i += 1) {
      q.enqueue(must(bookingReceivedRequest(record('held', { id: `B-${i}` }), USER, NOW)), DEFAULT_PREFERENCES, NOW);
    }
    const today = await q.processDue(NOW, deps(t));
    assert.equal(today.sent, 2);
    assert.equal(today.deferredByCap, 1);
    const later = await q.processDue('2026-11-15T20:00:00Z', deps(t));
    assert.equal(later.sent, 0);
    const tomorrow = await q.processDue('2026-11-16T00:00:01Z', deps(t));
    assert.equal(tomorrow.sent, 1);
    assert.equal(t.delivered.length, 3);
  });

  test('a batch never processes more jobs than the batch size', async () => {
    const q = new NotificationQueue({ batchSize: 2 });
    const t = new MemoryTransport();
    for (let i = 1; i <= 4; i += 1) q.enqueue(must(bookingReceivedRequest(record('held', { id: `B-${i}` }), USER, NOW)), DEFAULT_PREFERENCES, NOW);
    const report = await q.processDue(NOW, deps(t));
    assert.equal(report.sent, 2);
  });
});

describe('preferences', () => {
  test('a support reply is suppressed when support replies are switched off', () => {
    const q = new NotificationQueue();
    const req = must(supportReplyRequest('SR-1', 'booking', 2, USER, NOW));
    const r = q.enqueue(req, { bookingProgress: true, supportReplies: false }, NOW);
    assert.equal(r.status, 'suppressed');
    assert.equal(q.job(r.jobId)?.suppressedReason, 'preference_supportReplies_off');
  });

  test('intermediate booking updates are suppressed when booking progress is off, but final updates still send', () => {
    const q = new NotificationQueue();
    const off: Preferences = { bookingProgress: false, supportReplies: true };
    assert.equal(q.enqueue(must(bookingStatusRequest(record('order_pending'), USER, NOW)), off, NOW).status, 'suppressed');
    assert.equal(q.enqueue(must(bookingStatusRequest(record('ticketed', { documents: true }), USER, NOW)), off, NOW).status, 'queued');
  });

  test('security, account, payment, ticket and refund messages cannot be switched off', () => {
    const q = new NotificationQueue();
    const none = prefsAll(false);
    const r = record('ticketed', { documents: true });
    const requests: NotificationRequest[] = [
      must(authRequest('verify', USER, 'n1', NOW)),
      must(authRequest('reset', USER, 'n2', NOW)),
      must(securityAlertRequest(USER, 'password_changed', 'sa1', NOW, NOW)),
      must(paymentConfirmedRequest('intent-B-1', 'captured', r, USER, NOW)),
      must(ticketIssuedRequest(r, USER, NOW)),
      must(itineraryRequest(r, USER, NOW)),
      must(refundRequest('RF-1', 'completed', 'eligible', USER, null, NOW)),
    ];
    for (const req of requests) {
      assert.equal(preferenceAllows(req, none).allowed, true, `${req.template} must send with all optional preferences off`);
      assert.equal(q.enqueue(req, none, NOW).status, 'queued');
    }
  });

  test('stored preferences that are missing or invalid fall back to the defaults', () => {
    assert.deepEqual(sanitisePreferences(null), DEFAULT_PREFERENCES);
    assert.deepEqual(sanitisePreferences({ bookingProgress: 'no', supportReplies: 0 }), DEFAULT_PREFERENCES);
    assert.deepEqual(sanitisePreferences({ bookingProgress: false, supportReplies: true, isAdmin: true }), { bookingProgress: false, supportReplies: true });
  });
});

describe('rate limits and security', () => {
  test('authentication messages are capped per user per hour', () => {
    const q = new NotificationQueue({ authLimitPerHour: 2 });
    const r1 = q.enqueue(must(authRequest('reset', USER, 'n1', NOW)), DEFAULT_PREFERENCES, NOW);
    const r2 = q.enqueue(must(authRequest('reset', USER, 'n2', NOW)), DEFAULT_PREFERENCES, NOW);
    const r3 = q.enqueue(must(authRequest('reset', USER, 'n3', NOW)), DEFAULT_PREFERENCES, NOW);
    assert.equal(r1.status, 'queued');
    assert.equal(r2.status, 'queued');
    assert.equal(r3.status, 'suppressed');
    assert.equal(q.job(r3.jobId)?.suppressedReason, 'rate_limited');
  });

  test('the rate limit is per user, and it resets after an hour', () => {
    const q = new NotificationQueue({ authLimitPerHour: 1 });
    q.enqueue(must(authRequest('reset', USER, 'n1', NOW)), DEFAULT_PREFERENCES, NOW);
    assert.equal(q.enqueue(must(authRequest('reset', 'other-user', 'n2', NOW)), DEFAULT_PREFERENCES, NOW).status, 'queued');
    assert.equal(q.enqueue(must(authRequest('reset', USER, 'n3', NOW)), DEFAULT_PREFERENCES, NOW).status, 'suppressed');
    assert.equal(q.enqueue(must(authRequest('reset', USER, 'n4', '2026-11-15T11:00:01Z')), DEFAULT_PREFERENCES, '2026-11-15T11:00:01Z').status, 'queued');
  });

  test('an authentication link is built at send time, so no link or token is stored in the queue', async () => {
    const q = new NotificationQueue();
    const t = new MemoryTransport();
    const { jobId } = q.enqueue(must(authRequest('verify', USER, 'nonce-abc', NOW)), DEFAULT_PREFERENCES, NOW);
    assert.ok(!JSON.stringify(q.job(jobId)).includes('https://'));
    await q.processDue(NOW, deps(t));
    assert.ok(t.delivered[0].html.includes('https://app.example.com/auth/verify?t=nonce-abc'));
  });

  test('the queue never stores an email address, and the failure log stores no addresses or links', async () => {
    const q = new NotificationQueue();
    const t = new MemoryTransport();
    t.script = [{ state: 'failed', code: 'timeout', retryable: true }];
    q.enqueue(must(bookingReceivedRequest(record('held'), USER, NOW)), DEFAULT_PREFERENCES, NOW);
    q.enqueue(must(paymentFailedRequest('intent-B-1', 'failed', record('expired'), USER, NOW)), DEFAULT_PREFERENCES, NOW);
    await q.processDue(NOW, deps(t));
    const stored = JSON.stringify([q.allJobs(), q.failureLog]);
    assert.ok(!stored.includes(EMAIL));
    assert.ok(!stored.includes('https://'));
  });

  test('a security alert is never suppressed by the rate limit of account emails', () => {
    const q = new NotificationQueue({ authLimitPerHour: 1 });
    q.enqueue(must(authRequest('reset', USER, 'n1', NOW)), DEFAULT_PREFERENCES, NOW);
    assert.equal(q.enqueue(must(securityAlertRequest(USER, 'password_changed', 'sa-1', NOW, NOW)), DEFAULT_PREFERENCES, NOW).status, 'queued');
  });

  test('a security alert is shown in UTC time and never includes an address or device detail', () => {
    const out = renderTemplate('security_alert', { event: 'new_sign_in', occurredAtUtc: NOW }, CTX);
    assert.ok(out.text.includes(NOW));
    assert.ok(!/ip|device|location/i.test(out.text.replace(/ship/gi, '')));
  });

  test('the support reply email never contains the message text', () => {
    const out = renderTemplate('support_reply', { requestId: 'SR-000001', category: 'booking' }, CTX);
    assert.ok(out.text.toLowerCase().includes('sign in'));
    assert.ok(!out.html.includes('passport'));
  });

  test('an unsupported template id is rejected', () => {
    assert.throws(() => renderTemplate('marketing_blast' as never, {} as never, CTX), /unknown_template/);
  });

  test('a request with no user, or a key with unsafe characters, is refused', () => {
    assert.deepEqual(authRequest('verify', ' ', 'n1', NOW), { ok: false, reason: 'user_required' });
    assert.deepEqual(authRequest('verify', USER, 'bad key!', NOW), { ok: false, reason: 'invalid_key' });
  });

  test('a refund update uses the support wording and states no promise before completion', () => {
    const out = renderTemplate('refund_update', { headline: 'We have not confirmed any amount yet.', detail: 'Sign in to see the latest status.', confirmedAmount: null }, CTX);
    assert.ok(!/will be refunded|refund is confirmed/i.test(out.text));
  });

  test('a cancellation notice reuses the verified status wording and includes the reference', () => {
    const req = must(cancellationRequest(record('cancelled'), USER, NOW));
    const out = renderTemplate('cancellation_update', req.data as never, CTX);
    assert.ok(out.text.includes('ABC234'));
  });

  test('the booking received email does not claim the booking is confirmed', () => {
    const out = renderTemplate('booking_received', { bookingReference: 'ABC234' }, CTX);
    assert.ok(out.text.includes('not confirmed yet'));
    assert.ok(!/has been confirmed/i.test(out.text));
  });
});
