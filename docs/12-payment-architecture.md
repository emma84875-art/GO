# Payment architecture and provider findings

Date: 12 Nov 2026
Status: **foundation built and tested with a fixture. Production payments DISABLED. No provider confirmed for NGN authorisation.**

## Provider findings (from official documentation as read on 12 Nov 2026)

| Capability | Paystack | Flutterwave |
|---|---|---|
| Pre-authorisation (hold, then capture) | Documented for **South African registered businesses only**, in **ZAR only**, not enabled by default. Endpoints: `/preauthorization/initialize`, `/capture`, `/release`. Not available for an NGN merchant on the documentation read. | Documented: `preauthorize: true` on card charges; `POST /v3/charges/{ref}/capture`; `POST /v3/charges/{ref}/void`. **Off by default**, needs Flutterwave support to enable. **NGN appears only in examples**, not in a supported-currency list. Hold window 7 days. Multiple partial captures, total not above the authorised amount. |
| Webhook security | `x-paystack-signature`, HMAC SHA512 over the body, keyed with the secret key. Compare in constant time. Retries: every 3 minutes for 4 tries, then hourly for 72 hours (live). IP whitelisting applies to secret-key API calls; webhook IP list not found. No event ID documented. | `verif-hash` header compared with a static secret hash (not an HMAC). No event ID documented; deduplicate on event + transaction ID + status. Retries: 3 at 30-minute intervals; any non-200 is a failure. |
| Bank transfer | **Not confirmed** in this session | **Not confirmed** in this session |
| Settlement and fees | **Not confirmed** in this session. No figures used. | **Not confirmed** in this session. No figures used. |

Sources: [Paystack card pre-authorisation](https://paystack.com/docs/payments/card-preauthorization/), [Paystack support on pre-authorisation](https://support.paystack.com/en/articles/10450882), [Paystack webhooks](https://paystack.com/docs/payments/webhooks/), [Paystack webhook signature (secondary)](https://mctaba.com/learn/paystack/verifying-the-x-paystack-signature-header-correctly), [Flutterwave pre-authorisation](https://developer.flutterwave.com/docs/preauthorization), [Flutterwave webhooks](https://developer.flutterwave.com/docs/webhooks).

Not verified in this session: Paystack's `/transaction/initialize` and `/transaction/verify` endpoints (written from general knowledge, marked in code), Paystack's webhook IP list, and Flutterwave's status and charge endpoints. Each must be checked in a sandbox.

**Recommendation for the owner:** ask Paystack and Flutterwave in writing whether NGN card pre-authorisation (or hold-then-capture) is available to our merchant account, its eligibility rules, and its fees. Until a provider confirms in writing, Option A cannot run in production.

## Architecture (packages/payments)

- `provider.ts`: common interface (initiate, status, capture, release, refund, webhook verify and parse). Capabilities are `supported`, `unconfirmed` or `not_supported`, each with evidence.
- `state.ts`: payment states and the only legal transitions. Anything else goes to `review_required`.
- `transitions.ts`: the only place a state changes. Every change is written to the audit log.
- `payment-flow.ts`: starts payment only for a valid booking. Checks, in order: no live payment for this booking (duplicate guard), owner production gate, provider authorisation confirmed, live hold, fare revalidated with the supplier, amount equals the accepted summary. Also capture after confirmed fulfilment, supplier-failure release, refunds, and expiry sweep.
- `money-safety.ts`: capture allowed only when the intent is authorised, supplier fulfilment is confirmed, the amount matches, the provider supports capture, and the window has not ended. Option B has no code path.
- `webhook.ts`: verify the signature over the raw body, deduplicate, then ask the provider for the true status and amount. Webhook bodies are never trusted alone.
- `reconcile.ts`: reports discrepancies only. Never changes state.
- `store.ts`: in-memory store with a read-only audit view. Persistence still to be built.

## Safety rules enforced

1. No payment starts unless the provider's authorisation is `supported`. Paystack and Flutterwave are both `unconfirmed` for NGN.
2. Production is off unless the owner gate is on.
3. Capture needs confirmed supplier fulfilment. Supplier failure releases the authorisation.
4. A payment after its window is never accepted silently. It goes to review.
5. Amount mismatches go to review. Nothing is captured.
6. Duplicate webhooks change state once. Duplicate payment attempts return the existing intent.

## Known limitations and outstanding decisions

- No database persistence yet. Booking, payment and audit tables are not wired.
- Paystack and Flutterwave endpoints beyond webhook handling are unverified and unexecuted.
- No fee schedule, settlement terms or bank-transfer support confirmed.
- Hold release with the supplier (`releaseHold`) is not in the supplier interface. Holds expire on their own timers.
- No background expiry job. The sweep has to be called by a scheduler (pg-boss not installed).
- Refund on the Paystack and Flutterwave adapters is not implemented.
- Decisions for the owner: approve the payment provider to pursue in writing; approve Option A as the only capture path; approve the fee policy; approve any live credentials, paid account or commercial commitment.
