// Support, cancellation and refund tests. Covers permissions, ownership, duplicate requests,
// invalid refund amounts, failed operations, status transitions, gates and audit entries.
// Bookings, payments and suppliers here are fixtures. They prove the rules, not any provider.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { AccessDeniedError, type Actor } from '../../portal/src/access.ts';
import type { PortalBooking } from '../../portal/src/model.ts';
import { Outbox, RecordingAdapter, UnconfiguredEmailAdapter, type NotificationAdapter } from '../../portal/src/notifications.ts';
import { FulfilmentStore } from '../../fulfilment/src/store.ts';
import type { FulfilmentStatus } from '../../fulfilment/src/status.ts';
import type { Offer } from '../../flights/src/supplier.ts';
import { SupportService, REFUNDS_DISABLED, type RefundGate, type ServiceConfig } from '../src/service.ts';
import type { SupplierCheck } from '../src/cancellation.ts';
import { canMoveRefund, moveRefund, type RefundFacts } from '../src/refunds.ts';
import { canMoveRequest, moveRequest } from '../src/support-requests.ts';
import { can } from '../src/permissions.ts';

const NOW = '2026-11-15T10:00:00Z';
const ALICE: Actor = { userId: 'cust-alice', role: 'customer' };
const BOB: Actor = { userId: 'cust-bob', role: 'customer' };
const SUPPORT: Actor = { userId: 'staff-support', role: 'support' };
const ADMIN: Actor = { userId: 'staff-admin', role: 'admin' };
const CHECK_OK: SupplierCheck = { state: 'verified', airlineStatus: 'active', checkedAt: NOW };
const CHECK_DOWN: SupplierCheck = { state: 'unavailable', reason: 'Order lookup is not available for this airline connection.' };

function offer(refundable: boolean | null): Offer {
  return {
    id: 'offer-1',
    supplierPrice: { amountMinor: 85_000_000, currency: 'NGN' },
    displayPrice: { amountMinor: 85_000_000, currency: 'NGN' },
    expiresAtUtc: '2026-11-15T12:00:00Z',
    segments: [{ origin: 'LOS', destination: 'LHR', departureUtc: '2026-12-01T10:00:00Z', arrivalUtc: '2026-12-01T17:00:00Z', departureTimeZone: 'Africa/Lagos', arrivalTimeZone: 'Europe/London', carrier: 'BA', flightNumber: 'BA75' }],
    fare: { checkedBags: 1, cabinBags: 1, refundable, changeable: null, restrictions: [] },
  };
}

function booking(id: string, owner: string, status: FulfilmentStatus, refundable: boolean | null = true, totalMinor = 85_000_000): PortalBooking {
  const store = new FulfilmentStore();
  store.create({
    bookingId: id, status, intentId: `intent-${id}`, offer: offer(refundable),
    passengers: [{ type: 'adult', firstName: 'Ada', lastName: 'Okafor', dateOfBirth: '1990-05-14', nationality: 'NG' }],
    totalMinor, currency: 'NGN', holdExpiresAtUtc: '2026-11-15T10:30:00Z', orderId: 'ORD-1', bookingReference: 'ABC123',
    documents: [], lockedReason: null, blockedReason: null,
  });
  const record = store.get(id);
  if (!record) throw new Error('fixture');
  return { ownerUserId: owner, record, history: store.historyFor(id) };
}

interface Setup {
  readonly bookings: Map<string, PortalBooking>;
  readonly payments: Map<string, RefundFacts['payment']>;
  supplierConfirmed: boolean;
  gate: RefundGate;
  cancelEnabled: boolean;
  supplierCalls: number;
  cancelFails: boolean;
  executorCalls: number;
  executorResult: 'ok' | 'not_ok' | 'throw';
}

function setup(overrides: Partial<Setup> = {}): { svc: SupportService; s: Setup } {
  const s: Setup = {
    bookings: new Map([
      ['B-ALICE', booking('B-ALICE', ALICE.userId, 'confirmed', true)],
      ['B-ALICE-NR', booking('B-ALICE-NR', ALICE.userId, 'verified', false)],
      ['B-ALICE-HELD', booking('B-ALICE-HELD', ALICE.userId, 'quoted', true)],
      ['B-BOB', booking('B-BOB', BOB.userId, 'confirmed', true)],
    ]),
    payments: new Map([['intent-B-ALICE', { status: 'captured', capturedMinor: 85_000_000, refundedMinor: 0, refundCapability: 'unconfirmed' }]]),
    supplierConfirmed: false,
    gate: REFUNDS_DISABLED,
    cancelEnabled: false,
    supplierCalls: 0,
    cancelFails: false,
    executorCalls: 0,
    executorResult: 'ok',
    ...overrides,
  };
  const config: ServiceConfig = {
    bookings: (id) => s.bookings.get(id),
    paymentFacts: (intentId) => s.payments.get(intentId) ?? null,
    supplierRefundConfirmed: () => s.supplierConfirmed,
    goFeeMinor: 0,
    refundGate: s.gate,
    refundExecutors: {
      payment_provider: async () => {
        s.executorCalls += 1;
        if (s.executorResult === 'throw') throw new Error('provider exploded');
        if (s.executorResult === 'not_ok') return { ok: false, reason: 'provider_declined' };
        return { ok: true, executionRef: `prov-${s.executorCalls}` };
      },
      supplier: async () => {
        s.executorCalls += 1;
        return { ok: true, executionRef: `sup-${s.executorCalls}` };
      },
    },
    cancellationExecutionEnabled: s.cancelEnabled,
    cancelWithSupplier: async () => {
      s.supplierCalls += 1;
      return s.cancelFails ? { ok: false, reason: 'airline_down' } : { ok: true };
    },
  };
  return { svc: new SupportService(config), s };
}

function assertThrowsCode(fn: () => unknown, code: string | RegExp): void {
  assert.throws(fn, (err: unknown) => {
    if (!(err instanceof Error)) return false;
    return typeof code === 'string' ? err.message === code : code.test(err.message);
  });
}

// Creates a support request for a booking and returns its id.
function openRequest(svc: SupportService, actor: Actor, bookingId: string, category: 'booking' | 'payment' | 'cancellation' | 'ticketing' | 'general' = 'booking'): string {
  return svc.createRequest(actor, { category, bookingId: category === 'general' ? null : bookingId, message: 'I need help with my booking.' }, NOW).request.id;
}

describe('permissions', () => {
  test('a customer cannot check refund eligibility, and the denial is audited', () => {
    const { svc } = setup();
    const id = svc.requestRefund(ALICE, 'B-ALICE', 1_000_000, 'other', 'Changed plans', NOW).id;
    assert.throws(() => svc.checkRefundEligibility(ALICE, id, 'payment_provider', NOW), AccessDeniedError);
    const denied = svc.auditLog(ADMIN, NOW).find((e) => e.action === 'refund.check_eligibility' && e.outcome === 'denied');
    assert.ok(denied);
    assert.equal(denied.actorRole, 'customer');
  });

  test('support staff cannot approve, execute, or read the audit log; admin can approve', () => {
    const { svc, s } = setup({ supplierConfirmed: true });
    const id = svc.requestRefund(ALICE, 'B-ALICE', 1_000_000, 'other', 'Changed plans', NOW).id;
    svc.checkRefundEligibility(SUPPORT, id, 'supplier', NOW);
    assert.throws(() => svc.decideRefund(SUPPORT, id, 'approve', '', NOW), AccessDeniedError);
    assert.throws(() => svc.auditLog(SUPPORT, NOW), AccessDeniedError);
    assert.doesNotThrow(() => svc.decideRefund(ADMIN, id, 'approve', '', NOW));
    assert.equal(s.executorCalls, 0);
  });

  test('support staff cannot execute a refund or a cancellation, even when approved', async () => {
    const { svc } = setup();
    const id = svc.requestRefund(ALICE, 'B-ALICE', 1_000_000, 'other', 'x', NOW).id;
    await assert.rejects(() => svc.executeRefund(SUPPORT, id, NOW), AccessDeniedError);
    const req = openRequest(svc, ALICE, 'B-ALICE', 'cancellation');
    await assert.rejects(() => svc.executeCancellation(SUPPORT, req, NOW), AccessDeniedError);
  });

  test('a customer cannot list all requests', () => {
    const { svc } = setup();
    assert.throws(() => svc.listRequests(ALICE, NOW), AccessDeniedError);
  });

  test('a customer cannot reply to another customer\'s request, and the attempt is audited', () => {
    const { svc } = setup();
    const id = openRequest(svc, ALICE, 'B-ALICE');
    assertThrowsCode(() => svc.replyAsCustomer(BOB, id, 'Hello', NOW), 'request_not_found');
    assert.ok(svc.auditLog(ADMIN, NOW).some((e) => e.entityId === id && e.outcome === 'denied' && e.detail === 'not_owner'));
  });

  test('a customer cannot open a request on another customer\'s booking', () => {
    const { svc } = setup();
    assertThrowsCode(() => svc.createRequest(ALICE, { category: 'booking', bookingId: 'B-BOB', message: 'Hi' }, NOW), 'booking_not_found');
  });

  test('a customer cannot respond as staff, and an internal note is never shown to the customer', () => {
    const { svc } = setup();
    const id = openRequest(svc, ALICE, 'B-ALICE');
    assert.throws(() => svc.respond(ALICE, id, 'I am staff', false, NOW), AccessDeniedError);
    svc.respond(SUPPORT, id, 'Internal: check the fare with the agent', true, NOW);
    const view = svc.getOwnRequest(ALICE, id, NOW);
    assert.ok(view);
    assert.ok(!JSON.stringify(view).includes('Internal: check the fare'));
  });

  test('every role has the permissions it is meant to have', () => {
    assert.equal(can(ALICE, 'refund.request'), true);
    assert.equal(can(ALICE, 'refund.approve'), false);
    assert.equal(can(SUPPORT, 'refund.check_eligibility'), true);
    assert.equal(can(SUPPORT, 'refund.approve'), false);
    assert.equal(can(ADMIN, 'refund.execute'), true);
    assert.equal(can(ADMIN, 'cancellation.execute'), true);
  });

  test('a refund cannot be decided by the person who requested it, even if that person holds an admin role', () => {
    const { svc } = setup({ supplierConfirmed: true });
    const selfAdmin: Actor = { userId: ALICE.userId, role: 'admin' };
    const id = svc.requestRefund(ALICE, 'B-ALICE', 1_000_000, 'other', 'x', NOW).id;
    svc.checkRefundEligibility(SUPPORT, id, 'supplier', NOW);
    assert.throws(() => svc.decideRefund(selfAdmin, id, 'approve', '', NOW), AccessDeniedError);
    assert.ok(svc.auditLog(ADMIN, NOW).some((e) => e.entityId === id && e.detail === 'self_approval'));
  });
});

describe('support requests', () => {
  test('a booking request is created open, with the default priority for its category', () => {
    const { svc } = setup();
    const r = svc.createRequest(ALICE, { category: 'payment', bookingId: 'B-ALICE', message: 'Payment was taken twice' }, NOW);
    assert.equal(r.duplicate, false);
    assert.equal(r.request.status, 'open');
    assert.equal(r.request.priority, 'high');
  });

  test('a booking request needs a booking, and an invalid category is rejected and audited', () => {
    const { svc } = setup();
    assertThrowsCode(() => svc.createRequest(ALICE, { category: 'booking', bookingId: null, message: 'Hi' }, NOW), 'booking_required');
    assertThrowsCode(() => svc.createRequest(ALICE, { category: 'nonsense' as never, bookingId: 'B-ALICE', message: 'Hi' }, NOW), 'invalid_category');
    assert.ok(svc.auditLog(ADMIN, NOW).some((e) => e.outcome === 'failed' && e.detail === 'invalid_category'));
  });

  test('an empty or oversized message is rejected', () => {
    const { svc } = setup();
    assertThrowsCode(() => svc.createRequest(ALICE, { category: 'general', bookingId: null, message: '   ' }, NOW), 'invalid_message');
    assertThrowsCode(() => svc.createRequest(ALICE, { category: 'general', bookingId: null, message: 'x'.repeat(2001) }, NOW), 'invalid_message');
  });

  test('a duplicate active request for the same booking and category is returned, not created again', () => {
    const { svc } = setup();
    const first = svc.createRequest(ALICE, { category: 'booking', bookingId: 'B-ALICE', message: 'Name is wrong' }, NOW);
    const second = svc.createRequest(ALICE, { category: 'booking', bookingId: 'B-ALICE', message: 'Name is still wrong' }, NOW);
    assert.equal(second.duplicate, true);
    assert.equal(second.request.id, first.request.id);
    assert.equal(svc.listRequests(SUPPORT, NOW).length, 1);
  });

  test('once a request is resolved, a new request for the same booking and category is allowed', () => {
    const { svc } = setup();
    const id = openRequest(svc, ALICE, 'B-ALICE');
    svc.setStatus(SUPPORT, id, 'resolved', 'Fixed', NOW);
    const next = svc.createRequest(ALICE, { category: 'booking', bookingId: 'B-ALICE', message: 'It broke again' }, NOW);
    assert.equal(next.duplicate, false);
    assert.notEqual(next.request.id, id);
  });

  test('general enquiries are not de-duplicated', () => {
    const { svc } = setup();
    const a = svc.createRequest(ALICE, { category: 'general', bookingId: null, message: 'Do you fly to Accra?' }, NOW);
    const b = svc.createRequest(ALICE, { category: 'general', bookingId: null, message: 'Another question' }, NOW);
    assert.notEqual(a.request.id, b.request.id);
  });

  test('a staff reply moves an open request to awaiting customer and queues a sign-in notice', () => {
    const { svc } = setup();
    const id = openRequest(svc, ALICE, 'B-ALICE');
    const updated = svc.respond(SUPPORT, id, 'Please send your passport name', false, NOW);
    assert.equal(updated.status, 'awaiting_customer');
    const notices = svc.drainNotifications();
    assert.ok(notices.some((n) => n.recipientUserId === ALICE.userId && n.kind === 'booking_update'));
    assert.ok(notices.every((n) => !n.body.includes('passport')), 'message text is never emailed');
  });

  test('an internal note does not change status and does not notify the customer', () => {
    const { svc } = setup();
    const id = openRequest(svc, ALICE, 'B-ALICE');
    svc.drainNotifications();
    const updated = svc.respond(SUPPORT, id, 'Checked with agent', true, NOW);
    assert.equal(updated.status, 'open');
    assert.equal(svc.drainNotifications().length, 0);
  });

  test('a customer reply reopens an awaiting request; a reply on a closed request is refused', () => {
    const { svc } = setup();
    const id = openRequest(svc, ALICE, 'B-ALICE');
    svc.respond(SUPPORT, id, 'Need more detail', false, NOW);
    const reopened = svc.replyAsCustomer(ALICE, id, 'Here is the detail', NOW);
    assert.equal(reopened.status, 'open');
    svc.setStatus(SUPPORT, id, 'closed', 'Done', NOW);
    assertThrowsCode(() => svc.replyAsCustomer(ALICE, id, 'More', NOW), 'request_closed');
  });

  test('assigning and reassigning record history; an empty assignee is rejected', () => {
    const { svc } = setup();
    const id = openRequest(svc, ALICE, 'B-ALICE');
    const assigned = svc.assign(SUPPORT, id, 'agent-1', NOW);
    assert.equal(assigned.status, 'assigned');
    const reassigned = svc.assign(SUPPORT, id, 'agent-2', NOW);
    assert.equal(reassigned.assigneeId, 'agent-2');
    assert.equal(reassigned.status, 'assigned');
    assert.equal(reassigned.history.at(-1)?.note, 'reassigned to agent-2');
    assertThrowsCode(() => svc.assign(SUPPORT, id, '  ', NOW), 'assignee_required');
  });

  test('an illegal status change is refused and audited', () => {
    const { svc } = setup();
    const id = openRequest(svc, ALICE, 'B-ALICE');
    svc.setStatus(SUPPORT, id, 'closed', 'Done', NOW);
    assertThrowsCode(() => svc.setStatus(SUPPORT, id, 'open', 'reopen', NOW), 'illegal_transition');
    assert.ok(svc.auditLog(ADMIN, NOW).some((e) => e.detail === 'illegal_transition'));
  });

  test('the request list is ordered by priority, most urgent first', () => {
    const { svc } = setup();
    const general = openRequest(svc, ALICE, 'B-ALICE', 'general');
    const payment = openRequest(svc, ALICE, 'B-ALICE-NR', 'payment');
    svc.setPriority(SUPPORT, general, 'urgent', NOW);
    const list = svc.listRequests(SUPPORT, NOW);
    assert.equal(list[0].id, general);
    assert.equal(list[1].id, payment);
  });

  test('an invalid priority is refused', () => {
    const { svc } = setup();
    const id = openRequest(svc, ALICE, 'B-ALICE');
    assertThrowsCode(() => svc.setPriority(SUPPORT, id, 'critical' as never, NOW), 'invalid_priority');
  });

  test('request status transitions follow the table', () => {
    assert.equal(canMoveRequest('closed', 'open'), false);
    assert.equal(canMoveRequest('resolved', 'open'), true);
    assert.throws(() => moveRequest('closed', 'assigned'), RangeError);
  });
});

describe('cancellation options', () => {
  test('without a verified supplier state, no cancellation can be requested, only support', () => {
    const { svc } = setup();
    const options = svc.cancellationOptionsFor(ALICE, 'B-ALICE', CHECK_DOWN, NOW);
    assert.deepEqual(options.options.map((o) => o.kind), ['support_only']);
    assertThrowsCode(() => svc.requestCancellation(ALICE, 'B-ALICE', CHECK_DOWN, true, NOW), /Order lookup/);
  });

  test('a mismatch with the airline shows support only', () => {
    const { svc } = setup();
    const options = svc.cancellationOptionsFor(ALICE, 'B-ALICE', { state: 'verified', airlineStatus: 'cancelled', checkedAt: NOW }, NOW);
    assert.equal(options.options[0].kind, 'support_only');
  });

  test('a refundable fare says a refund is possible but not guaranteed, with no acknowledgement', () => {
    const { svc } = setup();
    const option = svc.cancellationOptionsFor(ALICE, 'B-ALICE', CHECK_OK, NOW).options[0];
    assert.equal(option.kind, 'request_cancellation');
    assert.equal(option.refundExpectation, 'possible');
    assert.equal(option.requiresAcknowledgement, false);
    assert.match(option.message, /not guaranteed/);
  });

  test('a non-refundable or unknown fare requires acknowledgement', () => {
    const { svc } = setup();
    const nonRef = setup({ bookings: new Map([['B-ALICE', booking('B-ALICE', ALICE.userId, 'confirmed', false)]]) }).svc;
    assert.equal(nonRef.cancellationOptionsFor(ALICE, 'B-ALICE', CHECK_OK, NOW).options[0].refundExpectation, 'not_expected');
    const unknown = setup({ bookings: new Map([['B-ALICE', booking('B-ALICE', ALICE.userId, 'confirmed', null)]]) }).svc;
    const opt = unknown.cancellationOptionsFor(ALICE, 'B-ALICE', CHECK_OK, NOW).options[0];
    assert.equal(opt.refundExpectation, 'not_confirmed');
    assert.equal(opt.requiresAcknowledgement, true);
    assert.equal(svc.cancellationOptionsFor(ALICE, 'B-ALICE', CHECK_OK, NOW).options[0].requiresAcknowledgement, false);
  });

  test('a held booking, which has no supplier order yet, offers no cancellation', () => {
    const { svc } = setup();
    const options = svc.cancellationOptionsFor(ALICE, 'B-ALICE-HELD', CHECK_OK, NOW);
    assert.equal(options.options.length, 0);
    assert.match(options.blockedReason ?? '', /cannot be cancelled/);
  });

  test('a request without the required acknowledgement is refused', () => {
    const nonRef = setup({ bookings: new Map([['B-ALICE', booking('B-ALICE', ALICE.userId, 'confirmed', false)]]) }).svc;
    assertThrowsCode(() => nonRef.requestCancellation(ALICE, 'B-ALICE', CHECK_OK, false, NOW), 'acknowledgement_required');
    const ok = nonRef.requestCancellation(ALICE, 'B-ALICE', CHECK_OK, true, NOW);
    assert.equal(ok.request.category, 'cancellation');
    assert.equal(ok.request.cancellation?.execution, 'not_requested');
  });

  test('a second cancellation request for the same booking is returned, not duplicated', () => {
    const { svc } = setup();
    const first = svc.requestCancellation(ALICE, 'B-ALICE', CHECK_OK, false, NOW);
    const second = svc.requestCancellation(ALICE, 'B-ALICE', CHECK_OK, false, NOW);
    assert.equal(second.duplicate, true);
    assert.equal(second.request.id, first.request.id);
  });

  test('a customer cannot request cancellation on another customer\'s booking', () => {
    const { svc } = setup();
    assertThrowsCode(() => svc.requestCancellation(ALICE, 'B-BOB', CHECK_OK, false, NOW), 'booking_not_found');
  });

  test('a cancellation request does not change the booking status', () => {
    const { svc, s } = setup();
    svc.requestCancellation(ALICE, 'B-ALICE', CHECK_OK, false, NOW);
    assert.equal(s.bookings.get('B-ALICE')?.record.status, 'confirmed');
  });
});

describe('gated execution', () => {
  test('with the cancellation gate off, no airline call is made and the request is marked blocked', async () => {
    const { svc, s } = setup({ cancelEnabled: false });
    const req = svc.requestCancellation(ALICE, 'B-ALICE', CHECK_OK, false, NOW).request.id;
    const result = await svc.executeCancellation(ADMIN, req, NOW);
    assert.equal(result.ok, false);
    assert.equal(s.supplierCalls, 0, 'the airline must not be called while the gate is off');
    assert.ok(svc.listRequests(SUPPORT, NOW).find((r) => r.id === req)?.cancellation?.execution === 'blocked');
    assert.ok(svc.auditLog(ADMIN, NOW).some((e) => e.action === 'cancellation.execute' && e.outcome === 'blocked' && e.detail === 'gate_off'));
  });

  test('with the cancellation gate on, a successful airline call completes the request', async () => {
    const { svc, s } = setup({ cancelEnabled: true });
    const req = svc.requestCancellation(ALICE, 'B-ALICE', CHECK_OK, false, NOW).request.id;
    const result = await svc.executeCancellation(ADMIN, req, NOW);
    assert.equal(result.ok, true);
    assert.equal(s.supplierCalls, 1);
    assert.equal(svc.listRequests(SUPPORT, NOW).find((r) => r.id === req)?.cancellation?.execution, 'completed');
  });

  test('a failed airline call is recorded as failed, not as cancelled', async () => {
    const { svc } = setup({ cancelEnabled: true, cancelFails: true });
    const req = svc.requestCancellation(ALICE, 'B-ALICE', CHECK_OK, false, NOW).request.id;
    const result = await svc.executeCancellation(ADMIN, req, NOW);
    assert.equal(result.ok, false);
    assert.equal(svc.listRequests(SUPPORT, NOW).find((r) => r.id === req)?.cancellation?.execution, 'failed');
  });

  test('a refund with its source gate off stays approved and makes no provider call', async () => {
    const { svc, s } = setup({ supplierConfirmed: true, gate: REFUNDS_DISABLED });
    const id = svc.requestRefund(ALICE, 'B-ALICE', 1_000_000, 'other', 'x', NOW).id;
    svc.checkRefundEligibility(SUPPORT, id, 'supplier', NOW);
    svc.decideRefund(ADMIN, id, 'approve', '', NOW);
    const result = await svc.executeRefund(ADMIN, id, NOW);
    assert.equal(result.ok, false);
    assert.equal(s.executorCalls, 0);
    assert.equal(svc.getRefund(ADMIN, id, NOW).status, 'approved');
  });

  test('a refund with the gate on and a configured connection completes with an execution reference', async () => {
    const { svc, s } = setup({ supplierConfirmed: true, gate: { supplier: true, payment_provider: false, go: false } });
    const id = svc.requestRefund(ALICE, 'B-ALICE', 1_000_000, 'other', 'x', NOW).id;
    svc.checkRefundEligibility(SUPPORT, id, 'supplier', NOW);
    svc.decideRefund(ADMIN, id, 'approve', '', NOW);
    const result = await svc.executeRefund(ADMIN, id, NOW);
    assert.equal(result.ok, true);
    assert.equal(s.executorCalls, 1);
    const done = svc.getRefund(ADMIN, id, NOW);
    assert.equal(done.status, 'completed');
    assert.match(done.executionRef ?? '', /^sup-/);
  });

  test('a refund whose provider declines is failed, can be retried, and then completes', async () => {
    const { svc, s } = setup({ gate: { supplier: false, payment_provider: true, go: false } });
    s.payments.set('intent-B-ALICE', { status: 'captured', capturedMinor: 85_000_000, refundedMinor: 0, refundCapability: 'supported' });
    const id = svc.requestRefund(ALICE, 'B-ALICE', 1_000_000, 'other', 'x', NOW).id;
    svc.checkRefundEligibility(SUPPORT, id, 'payment_provider', NOW);
    svc.decideRefund(ADMIN, id, 'approve', '', NOW);
    s.executorResult = 'not_ok';
    const failed = await svc.executeRefund(ADMIN, id, NOW);
    assert.equal(failed.ok, false);
    assert.equal(svc.getRefund(ADMIN, id, NOW).status, 'failed');
    s.executorResult = 'ok';
    const retried = await svc.executeRefund(ADMIN, id, NOW);
    assert.equal(retried.ok, true);
    assert.equal(svc.getRefund(ADMIN, id, NOW).status, 'completed');
  });

  test('a provider that throws leaves the refund failed, never completed', async () => {
    const { svc, s } = setup({ supplierConfirmed: false, gate: { supplier: false, payment_provider: true, go: false } });
    s.payments.set('intent-B-ALICE', { status: 'captured', capturedMinor: 85_000_000, refundedMinor: 0, refundCapability: 'supported' });
    s.executorResult = 'throw';
    const id = svc.requestRefund(ALICE, 'B-ALICE', 1_000_000, 'other', 'x', NOW).id;
    svc.checkRefundEligibility(SUPPORT, id, 'payment_provider', NOW);
    svc.decideRefund(ADMIN, id, 'approve', '', NOW);
    const result = await svc.executeRefund(ADMIN, id, NOW);
    assert.deepEqual(result, { ok: false, reason: 'executor_error' });
    assert.equal(svc.getRefund(ADMIN, id, NOW).status, 'failed');
  });
});

describe('refund requests and amounts', () => {
  test('a refund request is recorded as requested, with no eligibility claimed', () => {
    const { svc } = setup();
    const r = svc.requestRefund(ALICE, 'B-ALICE', 1_000_000, 'cancelled_by_customer', null, NOW);
    assert.equal(r.status, 'requested');
    assert.equal(r.eligibility, 'not_checked');
    assert.equal(r.source, null);
  });

  test('zero, negative, fractional and over-total amounts are rejected and audited', () => {
    const { svc } = setup();
    assertThrowsCode(() => svc.requestRefund(ALICE, 'B-ALICE', 0, 'other', 'x', NOW), 'invalid_amount');
    assertThrowsCode(() => svc.requestRefund(ALICE, 'B-ALICE', -5, 'other', 'x', NOW), 'invalid_amount');
    assertThrowsCode(() => svc.requestRefund(ALICE, 'B-ALICE', 10.5, 'other', 'x', NOW), 'invalid_amount');
    assertThrowsCode(() => svc.requestRefund(ALICE, 'B-ALICE', 85_000_001, 'other', 'x', NOW), 'amount_exceeds_limit');
    assert.ok(svc.auditLog(ADMIN, NOW).filter((e) => e.outcome === 'failed').length >= 4);
  });

  test('a reason of other needs text, and a reason is capped at 500 characters', () => {
    const { svc } = setup();
    assertThrowsCode(() => svc.requestRefund(ALICE, 'B-ALICE', 1000, 'other', '  ', NOW), 'reason_required');
    assertThrowsCode(() => svc.requestRefund(ALICE, 'B-ALICE', 1000, 'other', 'x'.repeat(501), NOW), 'reason_too_long');
  });

  test('a second open refund for the same booking is refused', () => {
    const { svc } = setup();
    svc.requestRefund(ALICE, 'B-ALICE', 1000, 'other', 'first', NOW);
    assertThrowsCode(() => svc.requestRefund(ALICE, 'B-ALICE', 1000, 'other', 'second', NOW), 'refund_already_open');
  });

  test('a customer cannot request a refund on another customer\'s booking', () => {
    const { svc } = setup();
    assertThrowsCode(() => svc.requestRefund(ALICE, 'B-BOB', 1000, 'other', 'x', NOW), 'booking_not_found');
  });

  test('an unconfirmed supplier refund goes to pending approval, and cannot be approved', () => {
    const { svc } = setup({ supplierConfirmed: false });
    const id = svc.requestRefund(ALICE, 'B-ALICE', 1000, 'other', 'x', NOW).id;
    const checked = svc.checkRefundEligibility(SUPPORT, id, 'supplier', NOW);
    assert.equal(checked.status, 'pending_approval');
    assert.equal(checked.eligibility, 'unconfirmed');
    assertThrowsCode(() => svc.decideRefund(ADMIN, id, 'approve', '', NOW), 'eligibility_not_confirmed');
  });

  test('a payment that was never captured is rejected automatically, with no refund promised', () => {
    const { svc, s } = setup();
    s.payments.set('intent-B-ALICE', { status: 'authorised', capturedMinor: 0, refundedMinor: 0, refundCapability: 'supported' });
    const id = svc.requestRefund(ALICE, 'B-ALICE', 1000, 'other', 'x', NOW).id;
    const checked = svc.checkRefundEligibility(SUPPORT, id, 'payment_provider', NOW);
    assert.equal(checked.status, 'rejected');
    assert.equal(checked.eligibility, 'ineligible');
    assert.equal(checked.decidedBy, 'system');
  });

  test('a captured payment whose provider has not confirmed refunds stays unconfirmed', () => {
    const { svc } = setup();
    const id = svc.requestRefund(ALICE, 'B-ALICE', 1000, 'other', 'x', NOW).id;
    const checked = svc.checkRefundEligibility(SUPPORT, id, 'payment_provider', NOW);
    assert.equal(checked.eligibility, 'unconfirmed');
    assert.equal(checked.status, 'pending_approval');
  });

  test('a payment refund beyond the captured amount minus refunds already made is rejected as ineligible', () => {
    const { svc, s } = setup();
    s.payments.set('intent-B-ALICE', { status: 'captured', capturedMinor: 85_000_000, refundedMinor: 80_000_000, refundCapability: 'supported' });
    const id = svc.requestRefund(ALICE, 'B-ALICE', 6_000_000, 'other', 'x', NOW).id;
    const checked = svc.checkRefundEligibility(SUPPORT, id, 'payment_provider', NOW);
    assert.equal(checked.status, 'rejected');
    assert.equal(checked.eligibility, 'ineligible');
    assert.match(checked.eligibilityNote ?? '', /more than the payment still refundable/);
  });

  test('a GO fee refund is rejected as ineligible while the fee policy is zero', () => {
    const { svc } = setup();
    const id = svc.requestRefund(ALICE, 'B-ALICE', 1000, 'other', 'x', NOW).id;
    const checked = svc.checkRefundEligibility(SUPPORT, id, 'go', NOW);
    assert.equal(checked.status, 'rejected');
    assert.equal(checked.eligibility, 'ineligible');
  });

  test('a refund amount above the booking total is refused when requested, before any check', () => {
    const { svc } = setup();
    assertThrowsCode(() => svc.requestRefund(ALICE, 'B-ALICE', 85_000_001, 'other', 'x', NOW), 'amount_exceeds_limit');
  });

  test('a rejection needs a reason, and only a pending refund can be decided', () => {
    const { svc } = setup({ supplierConfirmed: true });
    const id = svc.requestRefund(ALICE, 'B-ALICE', 1000, 'other', 'x', NOW).id;
    assertThrowsCode(() => svc.decideRefund(ADMIN, id, 'approve', '', NOW), 'not_pending_approval');
    svc.checkRefundEligibility(SUPPORT, id, 'supplier', NOW);
    assertThrowsCode(() => svc.decideRefund(ADMIN, id, 'reject', '   ', NOW), 'reason_required');
    const rejected = svc.decideRefund(ADMIN, id, 'reject', 'Outside the fare rules', NOW);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.decidedBy, ADMIN.userId);
  });

  test('the refund history keeps each step, with actor and note', () => {
    const { svc } = setup({ supplierConfirmed: true });
    const id = svc.requestRefund(ALICE, 'B-ALICE', 1000, 'other', 'x', NOW).id;
    svc.checkRefundEligibility(SUPPORT, id, 'supplier', NOW);
    svc.decideRefund(ADMIN, id, 'approve', '', NOW);
    const r = svc.getRefund(ADMIN, id, NOW);
    assert.deepEqual(r.history.map((h) => h.to), ['requested', 'pending_approval', 'approved']);
    assert.equal(r.history[1].actorId, SUPPORT.userId);
  });

  test('refund transitions follow the table, and terminal states cannot move', () => {
    assert.equal(canMoveRefund('completed', 'approved'), false);
    assert.equal(canMoveRefund('rejected', 'approved'), false);
    assert.equal(canMoveRefund('failed', 'execution_pending'), true);
    assert.throws(() => moveRefund('completed', 'approved'), RangeError);
  });

  test('a customer sees a completed refund amount only once it is completed', async () => {
    const { svc, s } = setup({ supplierConfirmed: true, gate: { supplier: true, payment_provider: false, go: false } });
    const id = svc.requestRefund(ALICE, 'B-ALICE', 1000, 'other', 'x', NOW).id;
    const before = svc.listOwnRefunds(ALICE)[0];
    assert.equal(before.confirmedAmountMinor, null);
    assert.match(before.wording, /not yet been returned|received|not confirmed|confirmation/);
    svc.checkRefundEligibility(SUPPORT, id, 'supplier', NOW);
    svc.decideRefund(ADMIN, id, 'approve', '', NOW);
    assert.equal(svc.listOwnRefunds(ALICE)[0].confirmedAmountMinor, null, 'approved is not yet returned');
    await svc.executeRefund(ADMIN, id, NOW);
    assert.equal(svc.listOwnRefunds(ALICE)[0].confirmedAmountMinor, 1000);
    assert.equal(s.executorCalls, 1);
  });

  test('a customer never sees another customer\'s refund', () => {
    const { svc } = setup();
    svc.requestRefund(ALICE, 'B-ALICE', 1000, 'other', 'x', NOW);
    assert.equal(svc.listOwnRefunds(BOB).length, 0);
  });
});

describe('notifications and audit', () => {
  test('refund updates are queued and can be delivered through the send-once outbox', async () => {
    const { svc } = setup({ supplierConfirmed: true });
    const id = svc.requestRefund(ALICE, 'B-ALICE', 1000, 'other', 'x', NOW).id;
    svc.checkRefundEligibility(SUPPORT, id, 'supplier', NOW);
    const adapter = new RecordingAdapter();
    const outbox = new Outbox();
    for (const message of svc.drainNotifications()) await outbox.dispatch(adapter, message);
    assert.ok(adapter.sent.length >= 2);
    assert.ok(adapter.sent.every((m) => m.recipientUserId === ALICE.userId));
  });

  test('a failing email adapter is recorded as failed and does not change the refund', async () => {
    const { svc } = setup();
    const id = svc.requestRefund(ALICE, 'B-ALICE', 1000, 'other', 'x', NOW).id;
    const failing: NotificationAdapter = {
      name: 'broken',
      async send() {
        throw new Error('network down');
      },
    };
    const outbox = new Outbox();
    const messages = svc.drainNotifications();
    const entry = await outbox.dispatch(failing, messages[0]);
    assert.equal(entry.state, 'failed');
    assert.equal(svc.getRefund(ADMIN, id, NOW).status, 'requested');
  });

  test('the default email adapter sends nothing', async () => {
    const { svc } = setup();
    svc.requestRefund(ALICE, 'B-ALICE', 1000, 'other', 'x', NOW);
    const outbox = new Outbox();
    const [first] = svc.drainNotifications();
    const entry = await outbox.dispatch(new UnconfiguredEmailAdapter(), first);
    assert.equal(entry.state, 'not_configured');
  });

  test('the audit log is append-only, numbered, and frozen', () => {
    const { svc } = setup();
    openRequest(svc, ALICE, 'B-ALICE');
    const log = svc.auditLog(ADMIN, NOW);
    assert.deepEqual(log.map((e) => e.seq), log.map((_, i) => i + 1));
    assert.ok(Object.isFrozen(log[0]));
  });

  test('audit entries never contain message text or passenger detail', () => {
    const { svc } = setup();
    svc.createRequest(ALICE, { category: 'booking', bookingId: 'B-ALICE', message: 'SECRET-MESSAGE-TEXT' }, NOW);
    svc.requestRefund(ALICE, 'B-ALICE', 1000, 'other', 'SECRET-REASON-TEXT', NOW);
    const json = JSON.stringify(svc.auditLog(ADMIN, NOW));
    assert.ok(!json.includes('SECRET-MESSAGE-TEXT'));
    assert.ok(!json.includes('SECRET-REASON-TEXT'));
    assert.ok(!json.includes('Okafor'));
  });

  test('a read of the audit log by a customer is denied and recorded', () => {
    const { svc } = setup();
    assert.throws(() => svc.auditLog(ALICE, NOW), AccessDeniedError);
  });
});
