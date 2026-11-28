// Payment flow on the database authority (Phase 19.2, docs/26). Start, reconcile and webhook use the operation ledger
// and the payment authority. Nothing here keeps payment state in memory.
//
// Start is write-ahead:
//   1. The ledger records the start (payment.start) under a key that depends only on the booking.
//   2. The database records the payment as initiated, before the provider is called.
//   3. The provider is called once, with our reference as its idempotency key.
//   4. The provider's reference is recorded, and the ledger records success.
// If the provider's answer is lost, or any step after the provider call fails, the ledger records the outcome as unknown.
// An unknown start is never initiated again by the application. It is reconciled first, using the provider's own
// evidence, and only a provider answer that shows no payment for the reference allows another attempt.
//
// Capture is not in this file. It stays with request_payment_capture in the database (docs/26, section 5).

import { createHash, randomUUID } from 'node:crypto';
import { authorise, type Actor } from '../../auth/src/actor.ts';
import { requestFingerprint, type OperationLedger } from '../../operations/src/ledger.ts';
import type { PaymentAuthority, PaymentRow, ProviderEventResult } from './authority.ts';
import { BOOKING_PAYMENT_PROVIDERS, INTENT_WINDOW_MINUTES } from './payment-flow.ts';
import type { PaymentProvider } from './provider.ts';

export const PAYMENT_START_LEASE_SECONDS = 300;
export const PAYMENT_CURRENCIES = ['NGN', 'USD', 'GBP', 'EUR'] as const;

export interface StartRequest {
  readonly bookingId: string; // uuid of a quoted public.bookings row
  readonly ownerUserId: string;
  readonly amountMinor: number;
  readonly currency: (typeof PAYMENT_CURRENCIES)[number];
  readonly customerEmail: string;
  readonly holdExpiresAtUtc: string;
}

export interface Gate {
  readonly productionEnabled: boolean;
}

export interface StartDeps {
  readonly authority: PaymentAuthority;
  readonly ledger: OperationLedger;
  readonly provider: PaymentProvider;
  readonly gate: Gate;
  readonly leaseSeconds?: number; // the ledger lease for a start; tests shorten it to check expiry
}

export type StartOutcome =
  | { readonly status: 'started'; readonly paymentId: string; readonly providerReference: string; readonly reused: boolean }
  | { readonly status: 'blocked'; readonly reason: string }
  | { readonly status: 'reconciliation_required'; readonly paymentId: string | null; readonly reason: string }
  | { readonly status: 'refused'; readonly reason: string };

// The idempotency reference for a booking's payment start. It depends only on the booking, so a retry or a second
// process derives the same key. A second attempt after a confirmed failure uses the ledger's one allowed retry.
export function paymentStartReference(bookingId: string): string {
  return `booking:${bookingId}:payment_start:1`;
}

function actorLabel(actor: Actor): string {
  return actor.kind === 'system' ? `system:${actor.service}` : `user:${actor.userId}`;
}

export async function startPaymentDurable(deps: StartDeps, actor: Actor, request: StartRequest, nowUtc: string): Promise<StartOutcome> {
  authorise(actor, 'payment.start', request.ownerUserId);
  const { authority, ledger, provider, gate } = deps;

  if (!BOOKING_PAYMENT_PROVIDERS.includes(provider.name)) {
    return { status: 'refused', reason: 'This provider is not approved for booking payments.' };
  }
  if (provider.mode === 'production' && !gate.productionEnabled) {
    return { status: 'refused', reason: 'Production payments are disabled.' };
  }
  if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0) {
    return { status: 'refused', reason: 'The payment amount must be a positive whole number.' };
  }
  const now = Date.parse(nowUtc);
  const hold = Date.parse(request.holdExpiresAtUtc);
  if (!(hold > now)) {
    return { status: 'refused', reason: 'The hold has lapsed. No payment can start.' };
  }
  const intentExpiry = Math.min(now + INTENT_WINDOW_MINUTES * 60_000, hold);
  const expiresAtUtc = new Date(intentExpiry).toISOString();

  const reference = paymentStartReference(request.bookingId);
  const owner = randomUUID(); // the lease holder: only this attempt may record its result
  const begun = await ledger.begin({
    operationType: 'payment.start',
    idempotencyKey: reference,
    subjectRef: request.bookingId,
    fingerprint: requestFingerprint({ bookingId: request.bookingId, provider: provider.name, amountMinor: request.amountMinor, currency: request.currency }),
    actorLabel: `backend:${actorLabel(actor)}`,
    correlationId: reference,
    owner,
    leaseSeconds: deps.leaseSeconds ?? PAYMENT_START_LEASE_SECONDS,
  });

  switch (begun.decision) {
    case 'already_succeeded': {
      const row = await authority.load(begun.resultRef);
      if (!row || row.providerReference.startsWith('pending:')) {
        return { status: 'reconciliation_required', paymentId: begun.resultRef, reason: 'The start is recorded but the provider reference is not. Reconcile before anything else.' };
      }
      return { status: 'started', paymentId: row.id, providerReference: row.providerReference, reused: true };
    }
    case 'in_progress':
    case 'subject_busy':
      return { status: 'blocked', reason: 'A payment start for this booking is already in progress.' };
    case 'needs_reconciliation': {
      const row = await authority.findByReference(reference);
      return { status: 'reconciliation_required', paymentId: row?.id ?? null, reason: 'A previous start has an unknown outcome. Reconcile with the provider first.' };
    }
    case 'terminal_failure':
    case 'key_reused':
    case 'refused':
      return { status: 'refused', reason: 'The ledger does not allow this payment start.' };
    case 'started':
      break;
  }

  // Step 2: write ahead. The provider is not called unless this succeeds.
  let paymentId: string;
  try {
    paymentId = await authority.start({
      bookingId: request.bookingId,
      provider: provider.name,
      reference,
      amountMinor: request.amountMinor,
      currency: request.currency,
      expiresAtUtc,
    });
  } catch {
    // No provider call has happened, so this is safe to retry under the same key.
    await ledger.complete(begun.operationId, owner, { outcome: 'failed_retryable', failureCode: 'payment_record_not_written' }, reference);
    return { status: 'blocked', reason: 'The payment could not be recorded, so the provider was not contacted.' };
  }

  // Step 3: the provider call. Any error here is unknown, because the provider may have acted before the error.
  let providerReference: string;
  try {
    const result = await provider.initiate({
      reference,
      amount: { amountMinor: request.amountMinor, currency: request.currency },
      customerEmail: request.customerEmail,
      expiresAtUtc,
      mode: 'authorise',
    });
    providerReference = result.providerRef;
  } catch {
    await ledger.complete(begun.operationId, owner, { outcome: 'unknown', failureCode: 'payment_start_unknown' }, reference);
    return { status: 'reconciliation_required', paymentId, reason: 'The provider did not answer clearly. Reconcile before any new attempt.' };
  }

  // Step 4: record the provider's reference, then the ledger's success. If either fails after the provider accepted,
  // the outcome is unknown, not failed.
  try {
    await authority.bindProviderReference(paymentId, providerReference);
  } catch {
    await ledger.complete(begun.operationId, owner, { outcome: 'unknown', failureCode: 'provider_reference_not_recorded' }, reference);
    return { status: 'reconciliation_required', paymentId, reason: 'The provider accepted the payment, but its reference was not recorded. Reconcile.' };
  }
  const completed = await ledger.complete(begun.operationId, owner, { outcome: 'succeeded', resultRef: paymentId }, reference);
  if (completed !== 'completed') {
    return { status: 'reconciliation_required', paymentId, reason: 'The ledger rejected this attempt as stale. Reconcile.' };
  }
  return { status: 'started', paymentId, providerReference, reused: false };
}

export type ReconcileOutcome =
  | { readonly status: 'not_needed'; readonly operationStatus: string | null }
  | { readonly status: 'started'; readonly paymentId: string; readonly providerReference: string }
  | { readonly status: 'retry_allowed'; readonly reason: string }
  | { readonly status: 'review_required'; readonly reason: string }
  | { readonly status: 'unavailable'; readonly reason: string };

// Resolves an unknown start from the provider's own answer for our reference. It never sends a payment. It only records
// what the provider reports, or records that the provider reports nothing.
export async function reconcilePaymentStart(
  deps: { readonly authority: PaymentAuthority; readonly ledger: OperationLedger; readonly provider: PaymentProvider },
  bookingId: string,
  reconcilerLabel: string,
): Promise<ReconcileOutcome> {
  if (!reconcilerLabel.startsWith('reconciliation:')) {
    return { status: 'unavailable', reason: 'Reconciliation needs a reconciliation actor label.' };
  }
  const reference = paymentStartReference(bookingId);
  const operation = await deps.ledger.byKey('payment.start', reference);
  if (!operation || operation.status !== 'unknown') {
    return { status: 'not_needed', operationStatus: operation?.status ?? null };
  }
  if (!deps.provider.findByReference) {
    return { status: 'unavailable', reason: 'This provider cannot look up payments by reference, so the start stays unknown.' };
  }
  const stored: PaymentRow | null = await deps.authority.findByReference(reference);
  if (!stored) {
    return { status: 'review_required', reason: 'No stored payment exists for this reference. A person must check the provider.' };
  }
  const evidence = await deps.provider.findByReference(reference);

  if (!evidence) {
    // The provider reports no payment for our reference. One new attempt is then allowed under the same key.
    const outcome = await deps.ledger.reconcile(
      operation.id,
      { outcome: 'failed_retryable', failureCode: 'provider_has_no_payment', evidenceRef: `provider-lookup:${reference}:none` },
      reconcilerLabel,
      reference,
    );
    if (outcome !== 'reconciled') return { status: 'review_required', reason: 'The ledger refused the reconciliation.' };
    return { status: 'retry_allowed', reason: 'The provider reports no payment for this reference. One new attempt is allowed.' };
  }

  const amountMatches = evidence.status.amount.amountMinor === stored.amountMinor && evidence.status.amount.currency === stored.currency;
  if (!amountMatches) {
    return { status: 'review_required', reason: 'The provider payment does not match the stored amount or currency. A person must check.' };
  }
  try {
    await deps.authority.bindProviderReference(stored.id, evidence.providerRef);
  } catch {
    return { status: 'review_required', reason: 'The provider reference could not be recorded. A person must check.' };
  }
  const outcome = await deps.ledger.reconcile(
    operation.id,
    { outcome: 'succeeded', resultRef: stored.id, evidenceRef: `provider-lookup:${evidence.providerRef}` },
    reconcilerLabel,
    reference,
  );
  if (outcome !== 'reconciled') return { status: 'review_required', reason: 'The ledger refused the reconciliation.' };
  return { status: 'started', paymentId: stored.id, providerReference: evidence.providerRef };
}

// A rejected event is still recorded in the 19.1 audit trail. The table needs non-empty identifiers, so an event that
// could not be verified or parsed is recorded under fixed placeholders. None of them is trusted, and none changes a payment.
const UNIDENTIFIED = 'unidentified';

async function recordRejection(authority: PaymentAuthority, provider: string, nowUtc: string, digest: string): Promise<void> {
  await authority.applyProviderEvent({
    provider, eventId: UNIDENTIFIED, eventType: 'unverified', providerReference: UNIDENTIFIED, providerState: null,
    amountMinor: null, currency: null, occurredAtUtc: nowUtc, verification: 'none', payloadSha256: digest,
  });
}

export type WebhookOutcome =
  | { readonly status: 'rejected'; readonly reason: 'bad_signature' | 'malformed' }
  | { readonly status: ProviderEventResult; readonly eventId: string };

// Verified provider events go to the 19.1 function, which decides the change and records every attempt. A repeat of an
// event is a duplicate, found in the database, so no provider call is made.
export async function handleWebhookDurable(
  deps: { readonly authority: PaymentAuthority; readonly provider: PaymentProvider },
  rawBody: string,
  headers: Readonly<Record<string, string | undefined>>,
  nowUtc: string,
): Promise<WebhookOutcome> {
  const digest = createHash('sha256').update(rawBody).digest('hex');
  const provider = deps.provider.name;
  if (!deps.provider.verifyWebhook(rawBody, headers).valid) {
    await recordRejection(deps.authority, provider, nowUtc, digest);
    return { status: 'rejected', reason: 'bad_signature' };
  }
  let parsed;
  try {
    parsed = deps.provider.parseWebhook(rawBody);
  } catch {
    await recordRejection(deps.authority, provider, nowUtc, digest);
    return { status: 'rejected', reason: 'malformed' };
  }
  const result = await deps.authority.applyProviderEvent({
    provider,
    eventId: parsed.eventId,
    eventType: parsed.eventName,
    providerReference: parsed.providerRef,
    providerState: parsed.reportedState,
    amountMinor: parsed.reportedAmountMinor,
    currency: parsed.reportedCurrency,
    occurredAtUtc: nowUtc,
    verification: 'webhook_signature',
    payloadSha256: digest,
  });
  return { status: result, eventId: parsed.eventId };
}
