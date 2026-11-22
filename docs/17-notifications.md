# 17. Notifications and customer communication (Phase 13)

Status: built in the domain layer and tested. No email provider is connected, no account is created,
and no paid service is activated. Live sending is disabled until the owner approves a provider and
the checks in section 5 are complete.

## 1. What was built

`packages/notify` is a central notification service. It does not depend on any email provider. The
queue talks only to a `Transport` interface.

| File | Purpose |
| --- | --- |
| `src/render.ts` | Brand constants, escaping, safe text and HTTPS-only links, money and local-time formatting, responsive table-based layout with a text part. |
| `src/templates.ts` | The 12 templates and their typed data. No passenger name, date of birth, nationality, ticket number or free-text support message field exists. |
| `src/verified.ts` | Gates on verified system state: tickets, payment capture and payment failure. |
| `src/requests.ts` | Builders that return a typed request, or a refusal when the verified state does not support the message. |
| `src/preferences.ts` | Two optional preferences. Sanitises stored values. |
| `src/transport.ts` | The transport interface, an unconfigured transport (sends nothing) and an in-memory test double with provider-side idempotency. |
| `src/queue.ts` | Idempotent enqueue, preferences, auth rate limit, background delivery with backoff, daily cap, stale-claim recovery, failure log of codes only. |
| `src/renderer.ts` | Connects the queue to the templates. |
| `test/notify.test.ts` | 56 tests. |

## 2. Templates

| Template | Category | Preference | Sent only when |
| --- | --- | --- | --- |
| account_verification | account | required | a verification is requested (link built at send time, 30-minute expiry) |
| password_reset | account | required | a reset is requested (same link pattern) |
| security_alert | security | required | a security event is recorded |
| booking_received | booking | required | a booking request is accepted; says it is not confirmed yet |
| booking_status | booking | intermediate statuses optional, final ones required | a fulfilment status changes |
| payment_confirmed | payment | required | the payment is captured |
| payment_failed | payment | required | the payment failed or expired |
| ticket_issued | ticketing | required | the record is ticketed or confirmed AND has supplier documents |
| itinerary | ticketing | required | the same ticket gate; times shown in each airport's own zone |
| cancellation_update | booking | required | the record is cancellation_pending, cancelled, refund_pending or refunded |
| refund_update | refunds | required | a refund status changes; an amount is shown only when the refund is completed |
| support_reply | support | optional (support replies) | a support reply is published; the email carries no message text |

## 3. Safety rules enforced in code

- No ticket email before supplier issuance. `ticketsVerified` requires a ticketed or confirmed status and at least one supplier document. The tests cover each intermediate status and a "ticketed with no documents" record.
- No payment confirmation unless the payment is captured. Failure emails only for failed or expired.
- No confirmed refund amount unless the refund is completed.
- Booking received says the booking is not confirmed yet.
- Security, account, payment, ticket and refund messages cannot be switched off.
- Authentication messages are limited to 5 per user per hour. Security alerts are not limited by that rule.
- Duplicate events are suppressed by an idempotency key built from the entity and its state. A repeated state does not send again; a new state does.
- Text is escaped in HTML and control characters are stripped. Only HTTPS links are allowed, with no embedded credentials.
- The queue does not store an email address, a rendered body or a link. Job data is cleared once a job is sent, failed for good or dead. The failure log stores codes only. A transport error message is never stored, because it can contain addresses.
- Retries reuse the same idempotency key, so a provider that honours the key does not send twice.
- Daily cap: `dailySendCap` defaults to 100, the free-tier limit of the recommended provider. Jobs over the cap wait for the next UTC day.

## 4. Delivery behaviour

- Transient failures (including thrown errors and address-lookup errors) retry with backoff of 1, 5, 15, 60 and 360 minutes, then become `dead` after 5 attempts.
- Permanent failures stop at once: `failed`.
- A missing address is a permanent failure. A render error is a permanent failure.
- `not_configured` keeps the job queued for 15 minutes and does not count an attempt. Nothing is sent while no provider is connected.
- A claim older than 10 minutes (a crash mid-send) is released for retry.

The queue is in-memory in this phase. The approved stack names pg-boss for background work. It is not installed, because package installs are blocked in this environment. Persistence and the worker are a blocker for production.

## 5. Provider comparison

Each figure was checked against the provider's official page, fetched in this session, unless marked otherwise. Nothing has been signed up for.

| Provider | Free tier (verified) | Paid entry (verified) | Nigerian business eligibility | Data handling, DPA, data location | Status |
| --- | --- | --- | --- | --- | --- |
| Resend | 3,000 emails per month, 100 per day, 3 domains | Pro $20 per month for 50,000 | Not stated on the page | Not stated on the page | Verified pricing. Needs checking. |
| Postmark | 100 emails per month, no overage | Basic $15 per month for 10,000 | Not stated on the page | Not stated on the page | Verified pricing. Sandbox and production approval not stated. |
| Amazon SES | No free monthly sending; $0.10 per 1,000 outbound emails pay-as-you-go; $200 AWS Free Tier credits for new customers for 6 months | Pay-as-you-go | Not stated on the page; AWS account and payment method required | Not stated on the page | Verified pricing. Requires a payment method, which conflicts with the zero-capital constraint unless credits cover use. Sandbox and production access not stated. |
| Brevo | Not verified (official page not on the allowlist) | Not verified | Not verified | Not verified | Not assessed. |

Recommendation for the owner's decision: Resend's free tier (100 per day, 3,000 per month) is the best fit
for the zero-capital constraint among the verified options, and the daily cap of 100 in this code matches
it. Whether any provider requires a card for its free tier has not been verified and must be checked before
signup. Postmark's free tier is lower (100 per month), so it is only a fallback for testing. SES is the
cheapest at scale but requires an AWS account, so it is not suitable now. Before any signup, the owner must
confirm in writing with the provider: Nigerian business eligibility, data processing agreement, data
location, sandbox versus production rules, and the sender domain requirements. No provider has been chosen.

SMS and WhatsApp are not built. They are documented as optional future adapters behind the same transport
boundary. They will not be connected without the owner's approval and a paid-service decision.

## 6. Brand

Templates use the approved identity in docs/09: Brand Purple #512584 for the header, Brand Orange #FF5738
for the call to action, and ink #1A0B2E for the button label. White on orange is not used because it
fails text contrast (3.15:1). Ink on orange is 5.90:1. The derived dark shades (#2B1248 and #3B1B63) are
not used, because the owner has not approved them. The logo is provisional and is not embedded.

## 7. Tests

- `npm run test:unit`: 345 tests, all passing. This includes the 56 notify tests.
- The notify tests cover template rendering and escaping, HTTPS-only links, money formatting, reference validation, the ticket, itinerary, payment, cancellation and refund gates, duplicate events, the intermediate-versus-final status rule, retries with a shared idempotency key, backoff, dead letters, permanent failure, thrown transport errors, missing addresses, render errors, stale-claim recovery, the daily cap, the batch size, preferences, the auth rate limit, and privacy (no email address, no link and no passenger detail in queue data or the failure log).
- Strict type check (tsc, `--strict`, erasable syntax) passes for all `packages/notify/src` files. The test file cannot be fully type-checked here, because `@types/node` is not installed.

## 8. Blockers and limits

- Production build: not possible. There is no framework build tool installed and package installs are blocked (npm view next fails with ENOTFOUND). The unit tests and the notify type check are the only checks run.
- pg-boss is not installed, so the queue is not durable. Production delivery needs persistence and a worker.
- No provider is connected. The transport header for the idempotency key must be verified against the chosen provider's documentation before go-live.
- Nigerian business eligibility, DPA and data location are not stated by the verified provider pages.
- The repository has no authentication module. Auth templates take a nonce and a link builder from the caller.
- The Brevo pricing page was not verified.
- The queue and the portal and support adapters are not yet wired together. A notification adapter from the support and portal builders to `packages/notify` is still to be built after approval.
- Owner decisions still open: dark brand shades, trademark search, counsel choice, NGN authorisation, fee policy, Duffel sandbox and runbook, infant document rule and the GO refund fee.
