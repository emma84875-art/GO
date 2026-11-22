// Support service: the only place where requests, cancellations and refunds change state.
//
// Each public method, in order:
//   1. checks the permission for the actor's role (denials are audited and thrown),
//   2. checks ownership for customer actions (another customer's booking is "not found"),
//   3. validates input (bad amounts and messages are audited as failed and rejected),
//   4. changes state only through the transition tables,
//   5. writes the audit entry and queues any customer notification.
//
// Execution is gated. Cancellation execution and refund execution are off by default
// (ServiceConfig). With the gates off, no supplier or payment call is ever made.
// The existing fulfilment cancelBooking is not used here.

import { AccessDeniedError, type Actor, requireOperations } from '../../portal/src/access.ts';
import type { PortalBooking } from '../../portal/src/model.ts';
import type { OutboundMessage } from '../../portal/src/notifications.ts';
import { can, requirePermission } from './permissions.ts';
import { AuditLog, type AuditEntry, type AuditOutcome } from './audit.ts';
import { cancellationOptions, type SupplierCheck, type CancellationOptions } from './cancellation.ts';
import {
  ACTIVE_STATUSES,
  CATEGORIES,
  PRIORITIES,
  REQUEST_STATUSES,
  defaultPriority,
  moveRequest,
  validateMessage,
  type CancellationDetail,
  type Priority,
  type RequestCategory,
  type RequestStatus,
  type Response,
  type StatusChange,
  type SupportRequest,
} from './support-requests.ts';
import {
  customerRefundWording,
  evaluateEligibility,
  moveRefund,
  validateRefundAmount,
  REASON_CODES,
  REFUND_SOURCES,
  type Eligibility,
  type ReasonCode,
  type RefundFacts,
  type RefundRecord,
  type RefundSource,
  type RefundStatus,
  type RefundStep,
} from './refunds.ts';
import { requestReceivedMessage, refundUpdateMessage, staffResponseMessage } from './notifications.ts';

export interface RefundGate {
  readonly supplier: boolean;
  readonly payment_provider: boolean;
  readonly go: boolean;
}

export const REFUNDS_DISABLED: RefundGate = Object.freeze({ supplier: false, payment_provider: false, go: false });

export type RefundExecutor = (refund: RefundRecord) => Promise<{ ok: true; executionRef: string } | { ok: false; reason: string }>;

export interface ServiceConfig {
  readonly bookings: (bookingId: string) => PortalBooking | undefined;
  readonly paymentFacts: (intentId: string) => RefundFacts['payment'];
  readonly supplierRefundConfirmed: (bookingId: string) => boolean;
  readonly goFeeMinor: number;
  readonly refundGate: RefundGate;
  readonly refundExecutors?: Partial<Record<RefundSource, RefundExecutor>>;
  readonly cancellationExecutionEnabled: boolean;
  readonly cancelWithSupplier?: (bookingId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface RequestInput {
  readonly category: RequestCategory;
  readonly bookingId: string | null;
  readonly message: string;
}

export interface CustomerRequestView {
  readonly id: string;
  readonly category: RequestCategory;
  readonly bookingId: string | null;
  readonly status: RequestStatus;
  readonly createdAt: string;
  readonly responses: readonly { readonly at: string; readonly from: 'you' | 'GO support'; readonly body: string }[];
}

export type StaffRequestView = SupportRequest;

export interface CustomerRefundView {
  readonly id: string;
  readonly bookingId: string;
  readonly status: RefundStatus;
  readonly wording: string;
  readonly requestedAmountMinor: number;
  readonly confirmedAmountMinor: number | null; // only once completed
  readonly currency: string;
}

export type ExecutionResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export class SupportService {
  private readonly config: ServiceConfig;
  private readonly requests = new Map<string, SupportRequest>();
  private readonly refunds = new Map<string, RefundRecord>();
  private readonly audit = new AuditLog();
  private pending: OutboundMessage[] = [];
  private seq = 0;

  constructor(config: ServiceConfig) {
    this.config = config;
  }

  // --- audit helpers -------------------------------------------------------------------------

  private log(actor: Actor, action: string, entityType: AuditEntry['entityType'], entityId: string, outcome: AuditOutcome, detail: string, nowUtc: string): void {
    this.audit.record({ at: nowUtc, actorId: actor.userId, actorRole: actor.role, action, entityType, entityId, outcome, detail });
  }

  private deny(actor: Actor, permission: Parameters<typeof requirePermission>[1], action: string, entityType: AuditEntry['entityType'], entityId: string, nowUtc: string): never {
    this.log(actor, action, entityType, entityId, 'denied', `missing_${permission}`, nowUtc);
    throw new AccessDeniedError(`Role ${actor.role} may not ${permission}.`);
  }

  private check(actor: Actor, permission: Parameters<typeof requirePermission>[1], action: string, entityType: AuditEntry['entityType'], entityId: string, nowUtc: string): void {
    if (!can(actor, permission)) this.deny(actor, permission, action, entityType, entityId, nowUtc);
  }

  private fail(actor: Actor, action: string, entityType: AuditEntry['entityType'], entityId: string, code: string, nowUtc: string): never {
    this.log(actor, action, entityType, entityId, 'failed', code, nowUtc);
    throw new RangeError(code);
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(6, '0')}`;
  }

  private ownedBooking(actor: Actor, bookingId: string): PortalBooking | undefined {
    const booking = this.config.bookings(bookingId);
    if (!booking || booking.ownerUserId !== actor.userId) return undefined;
    return booking;
  }

  private staffBooking(bookingId: string): PortalBooking | undefined {
    return this.config.bookings(bookingId);
  }

  private setRequest(next: SupportRequest): void {
    this.requests.set(next.id, next);
  }

  private setRefund(next: RefundRecord): void {
    this.refunds.set(next.id, next);
  }

  private requestOrThrow(id: string): SupportRequest {
    const r = this.requests.get(id);
    if (!r) throw new RangeError('request_not_found');
    return r;
  }

  private refundOrThrow(id: string): RefundRecord {
    const r = this.refunds.get(id);
    if (!r) throw new RangeError('refund_not_found');
    return r;
  }

  private stepFor(at: string, actorId: string, from: RequestStatus | null, to: RequestStatus, note: string | null): StatusChange {
    return { at, actorId, from, to, note };
  }

  // --- support requests: customer --------------------------------------------------------------

  createRequest(actor: Actor, input: RequestInput, nowUtc: string): { readonly request: SupportRequest; readonly duplicate: boolean } {
    this.check(actor, 'support.create', 'support.create', 'support_request', 'new', nowUtc);
    if (!(CATEGORIES as readonly string[]).includes(input.category)) this.fail(actor, 'support.create', 'support_request', 'new', 'invalid_category', nowUtc);
    if (input.category !== 'general' && !input.bookingId) this.fail(actor, 'support.create', 'support_request', 'new', 'booking_required', nowUtc);
    let body: string;
    try {
      body = validateMessage(input.message);
    } catch {
      this.fail(actor, 'support.create', 'support_request', 'new', 'invalid_message', nowUtc);
    }
    if (input.bookingId && !this.ownedBooking(actor, input.bookingId)) {
      this.log(actor, 'support.create', 'support_request', 'new', 'denied', 'not_owner', nowUtc);
      throw new RangeError('booking_not_found');
    }
    if (input.bookingId && input.category !== 'general') {
      const existing = [...this.requests.values()].find(
        (r) => r.ownerUserId === actor.userId && r.category === input.category && r.bookingId === input.bookingId && ACTIVE_STATUSES.includes(r.status),
      );
      if (existing) {
        this.log(actor, 'support.create', 'support_request', existing.id, 'blocked', 'duplicate_returned', nowUtc);
        return { request: existing, duplicate: true };
      }
    }
    const id = this.nextId('SR');
    const request: SupportRequest = {
      id,
      ownerUserId: actor.userId,
      category: input.category,
      bookingId: input.bookingId,
      createdAt: nowUtc,
      status: 'open',
      priority: defaultPriority(input.category),
      assigneeId: null,
      responses: [{ seq: 1, at: nowUtc, authorId: actor.userId, authorRole: 'customer', internal: false, body }],
      history: [this.stepFor(nowUtc, actor.userId, null, 'open', 'created')],
      cancellation: null,
    };
    this.setRequest(request);
    this.log(actor, 'support.create', 'support_request', id, 'succeeded', `category_${input.category}`, nowUtc);
    this.pending.push(requestReceivedMessage(request, nowUtc));
    return { request, duplicate: false };
  }

  listOwnRequests(actor: Actor, nowUtc: string): readonly CustomerRequestView[] {
    this.check(actor, 'support.read_own', 'support.read_own', 'support_request', 'list', nowUtc);
    return [...this.requests.values()]
      .filter((r) => r.ownerUserId === actor.userId)
      .map((r) => this.customerView(r))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getOwnRequest(actor: Actor, id: string, nowUtc: string): CustomerRequestView | null {
    this.check(actor, 'support.read_own', 'support.read_own', 'support_request', id, nowUtc);
    const r = this.requests.get(id);
    if (!r || r.ownerUserId !== actor.userId) return null;
    return this.customerView(r);
  }

  private customerView(r: SupportRequest): CustomerRequestView {
    return {
      id: r.id,
      category: r.category,
      bookingId: r.bookingId,
      status: r.status,
      createdAt: r.createdAt,
      responses: r.responses
        .filter((resp) => !resp.internal)
        .map((resp) => ({ at: resp.at, from: resp.authorRole === 'customer' ? 'you' : 'GO support', body: resp.body })),
    };
  }

  replyAsCustomer(actor: Actor, id: string, text: string, nowUtc: string): SupportRequest {
    this.check(actor, 'support.reply_own', 'support.reply', 'support_request', id, nowUtc);
    const r = this.requests.get(id);
    if (!r || r.ownerUserId !== actor.userId) {
      this.log(actor, 'support.reply', 'support_request', id, 'denied', 'not_owner', nowUtc);
      throw new RangeError('request_not_found');
    }
    if (r.status === 'closed') this.fail(actor, 'support.reply', 'support_request', id, 'request_closed', nowUtc);
    let body: string;
    try {
      body = validateMessage(text);
    } catch {
      this.fail(actor, 'support.reply', 'support_request', id, 'invalid_message', nowUtc);
    }
    const reopening = r.status === 'awaiting_customer' || r.status === 'resolved';
    const to: RequestStatus = reopening ? moveRequest(r.status, 'open') : r.status;
    const next: SupportRequest = {
      ...r,
      status: to,
      responses: [...r.responses, { seq: r.responses.length + 1, at: nowUtc, authorId: actor.userId, authorRole: 'customer', internal: false, body }],
      history: reopening ? [...r.history, this.stepFor(nowUtc, actor.userId, r.status, to, 'customer replied')] : r.history,
    };
    this.setRequest(next);
    this.log(actor, 'support.reply', 'support_request', id, 'succeeded', 'customer_reply', nowUtc);
    return next;
  }

  // --- support requests: staff -----------------------------------------------------------------

  listRequests(actor: Actor, nowUtc: string, filter: { readonly status?: RequestStatus; readonly category?: RequestCategory } = {}): readonly StaffRequestView[] {
    this.check(actor, 'support.read_all', 'support.read_all', 'support_request', 'list', nowUtc);
    const order: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
    return [...this.requests.values()]
      .filter((r) => (filter.status ? r.status === filter.status : true))
      .filter((r) => (filter.category ? r.category === filter.category : true))
      .sort((a, b) => order[a.priority] - order[b.priority] || a.createdAt.localeCompare(b.createdAt));
  }

  assign(actor: Actor, id: string, assigneeId: string, nowUtc: string): SupportRequest {
    this.check(actor, 'support.assign', 'support.assign', 'support_request', id, nowUtc);
    const r = this.requestOrThrow(id);
    if (!assigneeId.trim()) this.fail(actor, 'support.assign', 'support_request', id, 'assignee_required', nowUtc);
    const to: RequestStatus = r.status === 'assigned' ? 'assigned' : moveRequest(r.status, 'assigned');
    const note = r.status === 'assigned' ? `reassigned to ${assigneeId}` : `assigned to ${assigneeId}`;
    const next: SupportRequest = { ...r, status: to, assigneeId, history: [...r.history, this.stepFor(nowUtc, actor.userId, r.status, to, note)] };
    this.setRequest(next);
    this.log(actor, 'support.assign', 'support_request', id, 'succeeded', 'assigned', nowUtc);
    return next;
  }

  setPriority(actor: Actor, id: string, priority: Priority, nowUtc: string): SupportRequest {
    this.check(actor, 'support.triage', 'support.triage', 'support_request', id, nowUtc);
    const r = this.requestOrThrow(id);
    if (!(PRIORITIES as readonly string[]).includes(priority)) this.fail(actor, 'support.triage', 'support_request', id, 'invalid_priority', nowUtc);
    const next: SupportRequest = { ...r, priority };
    this.setRequest(next);
    this.log(actor, 'support.triage', 'support_request', id, 'succeeded', `priority_${priority}`, nowUtc);
    return next;
  }

  setStatus(actor: Actor, id: string, to: RequestStatus, note: string, nowUtc: string): SupportRequest {
    this.check(actor, 'support.triage', 'support.status', 'support_request', id, nowUtc);
    const r = this.requestOrThrow(id);
    if (!(REQUEST_STATUSES as readonly string[]).includes(to)) this.fail(actor, 'support.status', 'support_request', id, 'invalid_status', nowUtc);
    let nextStatus: RequestStatus;
    try {
      nextStatus = moveRequest(r.status, to);
    } catch {
      this.fail(actor, 'support.status', 'support_request', id, 'illegal_transition', nowUtc);
    }
    const next: SupportRequest = { ...r, status: nextStatus, history: [...r.history, this.stepFor(nowUtc, actor.userId, r.status, nextStatus, note.trim() || null)] };
    this.setRequest(next);
    this.log(actor, 'support.status', 'support_request', id, 'succeeded', `status_${nextStatus}`, nowUtc);
    return next;
  }

  respond(actor: Actor, id: string, text: string, internal: boolean, nowUtc: string): SupportRequest {
    this.check(actor, 'support.reply_staff', 'support.respond', 'support_request', id, nowUtc);
    if (internal) this.check(actor, 'support.internal_note', 'support.internal_note', 'support_request', id, nowUtc);
    const r = this.requestOrThrow(id);
    if (r.status === 'closed') this.fail(actor, 'support.respond', 'support_request', id, 'request_closed', nowUtc);
    let body: string;
    try {
      body = validateMessage(text);
    } catch {
      this.fail(actor, 'support.respond', 'support_request', id, 'invalid_message', nowUtc);
    }
    const response: Response = { seq: r.responses.length + 1, at: nowUtc, authorId: actor.userId, authorRole: 'staff', internal, body };
    let status: RequestStatus = r.status;
    let history = r.history;
    if (!internal && (r.status === 'open' || r.status === 'assigned')) {
      status = moveRequest(r.status, 'awaiting_customer');
      history = [...r.history, this.stepFor(nowUtc, actor.userId, r.status, status, 'staff replied')];
    }
    const next: SupportRequest = { ...r, status, responses: [...r.responses, response], history };
    this.setRequest(next);
    this.log(actor, 'support.respond', 'support_request', id, 'succeeded', internal ? 'internal_note' : 'staff_reply', nowUtc);
    if (!internal) this.pending.push(staffResponseMessage(next, response.seq, nowUtc));
    return next;
  }

  // --- cancellation ----------------------------------------------------------------------------

  cancellationOptionsFor(actor: Actor, bookingId: string, supplier: SupplierCheck, nowUtc: string): CancellationOptions {
    if (can(actor, 'cancellation.review')) {
      const booking = this.staffBooking(bookingId);
      if (!booking) this.fail(actor, 'cancellation.options', 'cancellation', bookingId, 'booking_not_found', nowUtc);
      this.log(actor, 'cancellation.options', 'cancellation', bookingId, 'succeeded', 'staff_view', nowUtc);
      return cancellationOptions(booking, supplier);
    }
    this.check(actor, 'cancellation.request', 'cancellation.options', 'cancellation', bookingId, nowUtc);
    const booking = this.ownedBooking(actor, bookingId);
    if (!booking) {
      this.log(actor, 'cancellation.options', 'cancellation', bookingId, 'denied', 'not_owner', nowUtc);
      throw new RangeError('booking_not_found');
    }
    return cancellationOptions(booking, supplier);
  }

  requestCancellation(actor: Actor, bookingId: string, supplier: SupplierCheck, acknowledged: boolean, nowUtc: string): { readonly request: SupportRequest; readonly duplicate: boolean } {
    this.check(actor, 'cancellation.request', 'cancellation.request', 'cancellation', bookingId, nowUtc);
    const booking = this.ownedBooking(actor, bookingId);
    if (!booking) {
      this.log(actor, 'cancellation.request', 'cancellation', bookingId, 'denied', 'not_owner', nowUtc);
      throw new RangeError('booking_not_found');
    }
    const options = cancellationOptions(booking, supplier);
    const option = options.options[0];
    if (!option || option.kind !== 'request_cancellation') {
      this.log(actor, 'cancellation.request', 'cancellation', bookingId, 'blocked', 'not_cancellable', nowUtc);
      throw new RangeError(options.blockedReason ?? 'not_cancellable');
    }
    if (option.requiresAcknowledgement && !acknowledged) {
      this.log(actor, 'cancellation.request', 'cancellation', bookingId, 'denied', 'acknowledgement_required', nowUtc);
      throw new RangeError('acknowledgement_required');
    }
    const existing = [...this.requests.values()].find(
      (r) => r.category === 'cancellation' && r.bookingId === bookingId && ACTIVE_STATUSES.includes(r.status),
    );
    if (existing) {
      this.log(actor, 'cancellation.request', 'cancellation', bookingId, 'blocked', 'duplicate_returned', nowUtc);
      return { request: existing, duplicate: true };
    }
    const id = this.nextId('SR');
    const detail: CancellationDetail = {
      acknowledgedFareRules: option.requiresAcknowledgement ? acknowledged : true,
      supplierCheckedAt: supplier.state === 'verified' ? supplier.checkedAt : null,
      execution: 'not_requested',
      executionReason: null,
    };
    const request: SupportRequest = {
      id,
      ownerUserId: actor.userId,
      category: 'cancellation',
      bookingId,
      createdAt: nowUtc,
      status: 'open',
      priority: defaultPriority('cancellation'),
      assigneeId: null,
      responses: [{ seq: 1, at: nowUtc, authorId: actor.userId, authorRole: 'customer', internal: false, body: 'Cancellation requested.' }],
      history: [this.stepFor(nowUtc, actor.userId, null, 'open', 'cancellation requested')],
      cancellation: detail,
    };
    this.setRequest(request);
    this.log(actor, 'cancellation.request', 'cancellation', id, 'succeeded', `refund_${option.refundExpectation}`, nowUtc);
    this.pending.push(requestReceivedMessage(request, nowUtc));
    return { request, duplicate: false };
  }

  // Gated. With cancellationExecutionEnabled false (the default) nothing is sent to the airline.
  async executeCancellation(actor: Actor, requestId: string, nowUtc: string): Promise<ExecutionResult> {
    this.check(actor, 'cancellation.execute', 'cancellation.execute', 'cancellation', requestId, nowUtc);
    const r = this.requestOrThrow(requestId);
    if (r.category !== 'cancellation' || !r.cancellation || r.bookingId === null) {
      this.fail(actor, 'cancellation.execute', 'cancellation', requestId, 'not_a_cancellation', nowUtc);
    }
    const gateReason = 'Cancellation execution is disabled until the airline integration is approved.';
    if (!this.config.cancellationExecutionEnabled || !this.config.cancelWithSupplier) {
      this.setRequest({ ...r, cancellation: { ...r.cancellation, execution: 'blocked', executionReason: gateReason } });
      this.log(actor, 'cancellation.execute', 'cancellation', requestId, 'blocked', 'gate_off', nowUtc);
      return { ok: false, reason: gateReason };
    }
    const bookingId = r.bookingId;
    try {
      const outcome = await this.config.cancelWithSupplier(bookingId);
      if (!outcome.ok) throw new Error(outcome.reason);
      this.setRequest({ ...r, cancellation: { ...r.cancellation, execution: 'completed', executionReason: null } });
      this.log(actor, 'cancellation.execute', 'cancellation', requestId, 'succeeded', 'supplier_cancelled', nowUtc);
      return { ok: true };
    } catch {
      this.setRequest({ ...r, cancellation: { ...r.cancellation, execution: 'failed', executionReason: 'supplier_error' } });
      this.log(actor, 'cancellation.execute', 'cancellation', requestId, 'failed', 'supplier_error', nowUtc);
      return { ok: false, reason: 'supplier_error' };
    }
  }

  // --- refunds ---------------------------------------------------------------------------------

  requestRefund(actor: Actor, bookingId: string, amountMinor: number, reasonCode: ReasonCode, reasonText: string | null, nowUtc: string): RefundRecord {
    this.check(actor, 'refund.request', 'refund.request', 'refund', bookingId, nowUtc);
    const booking = this.ownedBooking(actor, bookingId);
    if (!booking) {
      this.log(actor, 'refund.request', 'refund', bookingId, 'denied', 'not_owner', nowUtc);
      throw new RangeError('booking_not_found');
    }
    if (!(REASON_CODES as readonly string[]).includes(reasonCode)) this.fail(actor, 'refund.request', 'refund', bookingId, 'invalid_reason', nowUtc);
    const text = reasonText?.trim() ?? null;
    if (reasonCode === 'other' && (!text || text.length === 0)) this.fail(actor, 'refund.request', 'refund', bookingId, 'reason_required', nowUtc);
    if (text && text.length > 500) this.fail(actor, 'refund.request', 'refund', bookingId, 'reason_too_long', nowUtc);
    const total = booking.record.totalMinor;
    try {
      validateRefundAmount(amountMinor, total);
    } catch (e) {
      this.fail(actor, 'refund.request', 'refund', bookingId, e instanceof RangeError ? e.message : 'invalid_amount', nowUtc);
    }
    const open = [...this.refunds.values()].find(
      (r) => r.bookingId === bookingId && (r.status === 'requested' || r.status === 'pending_approval' || r.status === 'approved' || r.status === 'execution_pending'),
    );
    if (open) {
      this.log(actor, 'refund.request', 'refund', open.id, 'blocked', 'refund_already_open', nowUtc);
      throw new RangeError('refund_already_open');
    }
    const id = this.nextId('RF');
    const record: RefundRecord = {
      id,
      bookingId,
      requestedBy: actor.userId,
      requestedAmountMinor: amountMinor,
      currency: booking.record.currency,
      reasonCode,
      reasonText: text,
      createdAt: nowUtc,
      status: 'requested',
      source: null,
      amountMinor: null,
      eligibility: 'not_checked',
      eligibilityNote: null,
      decidedBy: null,
      executionRef: null,
      history: [{ at: nowUtc, actorId: actor.userId, from: null, to: 'requested', note: reasonCode }],
    };
    this.setRefund(record);
    this.log(actor, 'refund.request', 'refund', id, 'succeeded', `reason_${reasonCode}`, nowUtc);
    this.pending.push(refundUpdateMessage(record, 'requested', nowUtc));
    return record;
  }

  // Staff check. The source and amount are set here; eligibility comes only from confirmed facts.
  checkRefundEligibility(actor: Actor, refundId: string, source: RefundSource, nowUtc: string): RefundRecord {
    this.check(actor, 'refund.check_eligibility', 'refund.check_eligibility', 'refund', refundId, nowUtc);
    const r = this.refundOrThrow(refundId);
    if (r.status !== 'requested' && r.status !== 'pending_approval') this.fail(actor, 'refund.check_eligibility', 'refund', refundId, 'not_checkable', nowUtc);
    if (!(REFUND_SOURCES as readonly string[]).includes(source)) this.fail(actor, 'refund.check_eligibility', 'refund', refundId, 'invalid_source', nowUtc);
    const booking = this.staffBooking(r.bookingId);
    if (!booking) this.fail(actor, 'refund.check_eligibility', 'refund', refundId, 'booking_not_found', nowUtc);
    const facts: RefundFacts = {
      bookingTotalMinor: booking.record.totalMinor,
      supplierRefundConfirmed: this.config.supplierRefundConfirmed(r.bookingId),
      payment: this.config.paymentFacts(booking.record.intentId),
      goFeeMinor: this.config.goFeeMinor,
    };
    // The amount was validated as a positive whole number at request time. Amounts above what the
    // source can still refund are not an operation failure: they are recorded as ineligible, with
    // the reason, and the refund is rejected.
    if (!Number.isSafeInteger(r.requestedAmountMinor) || r.requestedAmountMinor <= 0) {
      this.fail(actor, 'refund.check_eligibility', 'refund', refundId, 'invalid_amount', nowUtc);
    }
    const result = evaluateEligibility(source, r.requestedAmountMinor, facts);
    const to: RefundStatus = result.eligibility === 'ineligible' ? 'rejected' : 'pending_approval';
    let status: RefundStatus;
    try {
      status = moveRefund(r.status, to);
    } catch {
      this.fail(actor, 'refund.check_eligibility', 'refund', refundId, 'illegal_transition', nowUtc);
    }
    const step: RefundStep = { at: nowUtc, actorId: actor.userId, from: r.status, to: status, note: `${source}: ${result.eligibility}. ${result.note}` };
    const next: RefundRecord = {
      ...r,
      status,
      source,
      amountMinor: r.requestedAmountMinor,
      eligibility: result.eligibility as Eligibility,
      eligibilityNote: result.note,
      decidedBy: result.eligibility === 'ineligible' ? 'system' : r.decidedBy,
      history: [...r.history, step],
    };
    this.setRefund(next);
    this.log(actor, 'refund.check_eligibility', 'refund', refundId, 'succeeded', `eligibility_${result.eligibility}`, nowUtc);
    if (status !== r.status) this.pending.push(refundUpdateMessage(next, status, nowUtc));
    return next;
  }

  // Admin decision. Approval needs confirmed eligibility, and the approver cannot be the requester.
  decideRefund(actor: Actor, refundId: string, decision: 'approve' | 'reject', reason: string, nowUtc: string): RefundRecord {
    this.check(actor, 'refund.approve', 'refund.decide', 'refund', refundId, nowUtc);
    const r = this.refundOrThrow(refundId);
    if (r.requestedBy === actor.userId) {
      this.log(actor, 'refund.decide', 'refund', refundId, 'denied', 'self_approval', nowUtc);
      throw new AccessDeniedError('A refund cannot be decided by the person who requested it.');
    }
    if (r.status !== 'pending_approval') this.fail(actor, 'refund.decide', 'refund', refundId, 'not_pending_approval', nowUtc);
    if (decision === 'approve' && r.eligibility !== 'eligible') this.fail(actor, 'refund.decide', 'refund', refundId, 'eligibility_not_confirmed', nowUtc);
    if (decision === 'reject' && reason.trim().length === 0) this.fail(actor, 'refund.decide', 'refund', refundId, 'reason_required', nowUtc);
    const to: RefundStatus = decision === 'approve' ? 'approved' : 'rejected';
    const next: RefundRecord = {
      ...r,
      status: moveRefund(r.status, to),
      decidedBy: actor.userId,
      history: [...r.history, { at: nowUtc, actorId: actor.userId, from: r.status, to, note: reason.trim() || null }],
    };
    this.setRefund(next);
    this.log(actor, 'refund.decide', 'refund', refundId, 'succeeded', decision, nowUtc);
    this.pending.push(refundUpdateMessage(next, to, nowUtc));
    return next;
  }

  // Gated by source. With the gate off (the default) no supplier or payment call is made and the
  // refund does not change state.
  async executeRefund(actor: Actor, refundId: string, nowUtc: string): Promise<ExecutionResult> {
    this.check(actor, 'refund.execute', 'refund.execute', 'refund', refundId, nowUtc);
    const r = this.refundOrThrow(refundId);
    if (r.status !== 'approved' && r.status !== 'failed') this.fail(actor, 'refund.execute', 'refund', refundId, 'not_approved', nowUtc);
    if (!r.source || r.amountMinor === null) this.fail(actor, 'refund.execute', 'refund', refundId, 'source_missing', nowUtc);
    const source = r.source;
    if (!this.config.refundGate[source]) {
      this.log(actor, 'refund.execute', 'refund', refundId, 'blocked', `gate_off_${source}`, nowUtc);
      return { ok: false, reason: `Refunds from the ${source} source are disabled until approved.` };
    }
    const executor = this.config.refundExecutors?.[source];
    if (!executor) {
      this.log(actor, 'refund.execute', 'refund', refundId, 'blocked', `no_executor_${source}`, nowUtc);
      return { ok: false, reason: `No ${source} refund connection is configured.` };
    }
    const pendingRecord: RefundRecord = {
      ...r,
      status: moveRefund(r.status, 'execution_pending'),
      history: [...r.history, { at: nowUtc, actorId: actor.userId, from: r.status, to: 'execution_pending', note: source }],
    };
    this.setRefund(pendingRecord);
    try {
      const outcome = await executor(pendingRecord);
      if (outcome.ok) {
        const done: RefundRecord = {
          ...pendingRecord,
          status: moveRefund('execution_pending', 'completed'),
          executionRef: outcome.executionRef,
          history: [...pendingRecord.history, { at: nowUtc, actorId: actor.userId, from: 'execution_pending', to: 'completed', note: null }],
        };
        this.setRefund(done);
        this.log(actor, 'refund.execute', 'refund', refundId, 'succeeded', `completed_${source}`, nowUtc);
        this.pending.push(refundUpdateMessage(done, 'completed', nowUtc));
        return { ok: true };
      }
      return this.failRefund(actor, pendingRecord, outcome.reason, nowUtc);
    } catch {
      return this.failRefund(actor, pendingRecord, 'executor_error', nowUtc);
    }
  }

  private failRefund(actor: Actor, record: RefundRecord, reason: string, nowUtc: string): ExecutionResult {
    const failed: RefundRecord = {
      ...record,
      status: moveRefund('execution_pending', 'failed'),
      history: [...record.history, { at: nowUtc, actorId: actor.userId, from: 'execution_pending', to: 'failed', note: reason }],
    };
    this.setRefund(failed);
    this.log(actor, 'refund.execute', 'refund', record.id, 'failed', reason, nowUtc);
    this.pending.push(refundUpdateMessage(failed, 'failed', nowUtc));
    return { ok: false, reason };
  }

  // Customer view of their own refunds. The confirmed amount is shown only once completed.
  listOwnRefunds(actor: Actor): readonly CustomerRefundView[] {
    requirePermission(actor, 'refund.request');
    // Read-only view. Denials here are thrown by requirePermission and are not audited.
    return [...this.refunds.values()]
      .filter((r) => r.requestedBy === actor.userId)
      .map((r) => ({
        id: r.id,
        bookingId: r.bookingId,
        status: r.status,
        wording: customerRefundWording(r.status, r.eligibility),
        requestedAmountMinor: r.requestedAmountMinor,
        confirmedAmountMinor: r.status === 'completed' ? r.amountMinor : null,
        currency: r.currency,
      }));
  }

  getRefund(actor: Actor, id: string, nowUtc: string): RefundRecord {
    requireOperations(actor);
    this.check(actor, 'refund.check_eligibility', 'refund.read', 'refund', id, nowUtc);
    return this.refundOrThrow(id);
  }

  // --- audit and notifications ------------------------------------------------------------------

  auditLog(actor: Actor, nowUtc: string): readonly AuditEntry[] {
    this.check(actor, 'audit.read', 'audit.read', 'support_request', 'audit', nowUtc);
    return this.audit.list();
  }

  drainNotifications(): readonly OutboundMessage[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

