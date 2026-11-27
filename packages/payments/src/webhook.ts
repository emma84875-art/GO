// Idempotent webhook processing. Order of checks:
//   1. Verify the signature over the raw body (rejects forged or altered bodies). Nothing else is read first.
//   2. Parse the body and find the intent by provider reference. Refuse an unknown reference.
//   3. Deduplicate on the provider's event identifier: a repeated delivery of the same event changes nothing.
//   4. Ask the provider for the true status and amount. The webhook body is never trusted alone, because providers
//      may resend stale or repeated events, and a browser redirect is never proof of payment.
//   5. Apply only a legal transition, or send the intent to review_required. Capture is confirmed only from a
//      provider result for a capture GO requested (capture_requested); a provider capture for anything else needs a person.
// Every outcome, including rejections and duplicates, is recorded with the event identifier, the event name, the time
// and the processing result. The actor recorded is the provider event, never a person.

import type { PaymentStore } from './store.ts';
import type { PaymentProvider } from './provider.ts';
import { moveIntent } from './transitions.ts';
import type { PaymentStatus } from './state.ts';

export type WebhookOutcome =
  | { readonly status: 'rejected'; readonly reason: 'bad_signature' | 'malformed' | 'unknown_reference' }
  | { readonly status: 'duplicate' }
  | { readonly status: 'no_change' }
  | { readonly status: 'applied'; readonly intentId: string; readonly to: PaymentStatus }
  | { readonly status: 'review_required'; readonly intentId: string; readonly reason: string };

export async function processWebhook(
  store: PaymentStore,
  provider: PaymentProvider,
  rawBody: string,
  headers: Readonly<Record<string, string | undefined>>,
  nowUtc: string,
): Promise<WebhookOutcome> {
  if (!provider.verifyWebhook(rawBody, headers).valid) {
    store.append({ at: nowUtc, intentId: 'none', event: 'webhook_rejected', from: null, to: null, detail: `${provider.name}: bad signature` });
    return { status: 'rejected', reason: 'bad_signature' };
  }

  let parsed;
  try {
    parsed = provider.parseWebhook(rawBody);
  } catch {
    store.append({ at: nowUtc, intentId: 'none', event: 'webhook_rejected', from: null, to: null, detail: `${provider.name}: malformed body` });
    return { status: 'rejected', reason: 'malformed' };
  }

  const eventKey = `${provider.name}|event|${parsed.eventId}`;
  const eventDetail = `${provider.name} event ${parsed.eventId} (${parsed.eventName}, reports ${parsed.reportedState}) at ${nowUtc}`;
  const intent = store.findByProviderRef(parsed.providerRef);
  if (!intent) {
    store.append({ at: nowUtc, intentId: 'none', event: 'webhook_unknown_reference', from: null, to: null, detail: `${eventDetail}: unknown reference` });
    return { status: 'rejected', reason: 'unknown_reference' };
  }

  // A repeat of an event we already processed is a no-op, not a second state change.
  if (!store.markWebhookProcessed(eventKey)) {
    store.append({ at: nowUtc, intentId: intent.id, event: 'webhook_duplicate', from: intent.status, to: intent.status, detail: `${eventDetail}: duplicate, no change` });
    return { status: 'duplicate' };
  }

  // If the status lookup fails, no state changed. Release the event key and rethrow, so the
  // provider's retry is processed rather than silently dropped as a duplicate.
  let truth;
  try {
    truth = await provider.getStatus(parsed.providerRef);
  } catch (error) {
    store.unmarkWebhookProcessed(eventKey);
    throw error;
  }

  if (truth.amount.amountMinor !== intent.amount.amountMinor || truth.amount.currency !== intent.amount.currency) {
    const updated = moveIntent(store, intent, 'review_required', 'amount_mismatch', nowUtc,
      `${eventDetail}; provider ${truth.amount.amountMinor} ${truth.amount.currency}, intent ${intent.amount.amountMinor} ${intent.amount.currency}`);
    return { status: 'review_required', intentId: updated.id, reason: 'amount_mismatch' };
  }

  const target = targetFor(truth.state, intent.status);
  if (target === 'none') {
    store.append({ at: nowUtc, intentId: intent.id, event: 'webhook_no_change', from: intent.status, to: intent.status, detail: eventDetail });
    return { status: 'no_change' };
  }
  if (target === 'expired_success') {
    const updated = moveIntent(store, intent, 'review_required', 'late_success', nowUtc,
      `${eventDetail}; provider reports success after the intent expired. Money may have moved; a person must decide.`);
    return { status: 'review_required', intentId: updated.id, reason: 'late_success' };
  }
  if (target === 'impossible') {
    const updated = moveIntent(store, intent, 'review_required', 'unexpected_state', nowUtc,
      `${eventDetail}; provider state ${truth.state} is not legal from ${intent.status}.`);
    return { status: 'review_required', intentId: updated.id, reason: 'unexpected_state' };
  }
  const updated = moveIntent(store, intent, target, `provider_${truth.state}`, nowUtc, eventDetail);
  return { status: 'applied', intentId: updated.id, to: target };
}

type Target = PaymentStatus | 'none' | 'expired_success' | 'impossible';

// The provider's reported state, read against where GO's intent already is. Capture needs a capture_requested
// intent (GO asked for it after ticket verification). Anything else reported as captured is unexpected.
function targetFor(state: string, current: PaymentStatus): Target {
  if (state === 'pending') return 'none';
  if (current === 'expired' && (state === 'authorised' || state === 'captured')) return 'expired_success';
  if (state === 'authorised') {
    return current === 'initiated' || current === 'review_required' || current === 'capture_requested' ? 'authorised' : 'none';
  }
  if (state === 'captured') {
    return current === 'capture_requested' ? 'captured' : current === 'captured' ? 'none' : 'impossible';
  }
  if (state === 'failed') return current === 'initiated' ? 'failed' : 'impossible';
  if (state === 'released') return current === 'authorised' || current === 'review_required' ? 'released' : 'none';
  return 'impossible';
}
