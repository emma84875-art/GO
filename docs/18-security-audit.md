# 18. Security, privacy and production-readiness audit (Phase 14)

Status: audit complete for the code that exists. GO is NOT production-ready. Several launch blockers
are missing components, not defects in existing code: there is no authentication module, no HTTP
server or application shell, no deployment configuration, and no persistence for payments or
fulfilment. Passing unit tests and the database checks does not make GO production-ready.

Payments, ticketing, supplier ordering and crypto stay disabled. Nothing was sent to any live service.
Nothing was committed or pushed.

## 1. Scope and method

- Read every SQL file, the payment, fulfilment, supplier, privacy, notification, support and portal
  modules that handle money, identity, passenger data or access.
- Scanned all files for hardcoded secrets, unsafe sinks (eval, innerHTML, shell execution, dynamic
  SQL), console logging, weak randomness and outbound URL handling.
- Ran the unit suite, and ran the database checks against a disposable local PostgreSQL 16 database
  (`scripts/test-db.sh`, which refuses any database name without "test").
- Did not run any test against Paystack, Flutterwave, Duffel, Supabase or any other live service.

What could not be checked:
- No frontend or server exists, so CSRF, XSS, CORS, security headers, rate limits, SSRF on HTTP
  endpoints and HTTPS termination cannot be assessed. They are listed as blockers.
- No lockfile and no declared dependencies (`package.json` has none), so a known-vulnerability audit
  cannot run. `npm audit` needs a lockfile, and package installs are blocked here.
- The RLS tests use a shim of Supabase's `auth.uid()` and roles on plain PostgreSQL 16, not a real
  Supabase project. Behaviour on Supabase must be confirmed in a Supabase test project.
- No production build is possible (no framework, package installs blocked).

## 2. Changes made in this phase

All changes are small, local and covered by tests. Each one is listed with its evidence.

| # | Severity | Change | Files |
| --- | --- | --- | --- |
| C1 | Critical | The airline was paid the customer's total (display currency, including GO's service fee). It is now paid the supplier price in the supplier's currency. | `packages/fulfilment/src/orchestrator.ts` (payAndRead), regression test in `fulfilment.test.ts` |
| C2 | Critical | Two concurrent payment starts for one booking both reached the provider, and the store kept only one intent. The second provider session could never be matched to a booking. A synchronous in-flight claim now refuses the second start. | `packages/payments/src/store.ts` (claimPaymentStart, releasePaymentStart), `payment-flow.ts` (startPayment wrapper, reason `start_in_progress`), regression test in `payments.test.ts` |
| H1 | High | A failed provider status lookup marked the webhook as processed, so the provider's retry was dropped as a duplicate and the payment was never applied. The dedupe key is now released and the error rethrown, so the retry is applied. | `packages/payments/src/webhook.ts`, `store.ts` (unmarkWebhookProcessed), regression test in `payments.test.ts` |
| H2 | High | Cancellation could reach a production supplier with the owner gate off. It is now refused with a blocked reason, and nothing is sent. | `packages/fulfilment/src/orchestrator.ts` (cancelBooking), regression test in `fulfilment.test.ts` |
| M1 | Medium | The customer screen showed internal lock reasons such as "Reconcile with the supplier before any retry". It now shows a neutral line. The internal reason remains for staff. | `packages/fulfilment/src/customer-view.ts`, regression test in `fulfilment.test.ts` |
| M2 | Medium | The Paystack redirect URL was passed to the customer without checks. It must now be HTTPS, carry no credentials and sit on a Paystack domain. The exact checkout host is unverified and must be confirmed in the sandbox. | `packages/payments/src/adapters/paystack.ts` (requirePaystackRedirect), tests in `payments.test.ts` |
| M3 | Medium | Future tables inherited default anon privileges in Supabase. Default anon privileges are now revoked, and `TRUNCATE` on the audit log is blocked by a trigger for every role. | `supabase/migrations/20261112000000_initial_schema.sql`, DB check 14 in `supabase/tests/rls_policies.sql` |
| M4 | Medium | The `payments` table's check constraints did not match the code. The status list had four values against nine states, and the provider list named `mock` and `stripe` and `crypto`. The constraints now match `state.ts` and the adapters. DB check 15 proves every state can be stored and an unknown one is refused. | same migration, same test file |

## 3. Test results

- `npm run test:unit`: 352 of 352 passing (345 before this phase, plus the new regression tests).
- Database checks on PostgreSQL 16 (`scripts/test-db.sh` as the postgres user): all checks pass,
  including the new checks 14 (TRUNCATE) and 15 (payment states).
- Strict type check (tsc) of the changed source files: no errors except the missing Node type
  definitions, which affect every file in the repo because `@types/node` is not installed.
- Production build: not possible (see section 1).

## 4. Findings still open, by priority

Each open finding gives evidence, affected files, business impact and the recommended remediation.
Items marked "needs approval" are architectural or commercial, so they are proposed and not implemented.

### Critical (launch blockers)

**X1. No authentication, session management, password recovery or role assignment layer exists.**
- Evidence: no auth module in the repo. `packages/notify` builds reset and verification emails from a
  nonce and a link builder that the caller supplies. `supabase/migrations` defines profiles and roles
  but no sign-in flow.
- Impact: customers cannot be identified safely, so every RLS policy and every portal view depends on
  an identity layer that does not yet exist.
- Remediation: use Supabase Auth with email verification, rate-limited sign-in, short-lived sessions,
  single-use password reset tokens (stored hashed, 30-minute expiry), MFA for staff, and lockout after
  repeated failures. Needs approval for the auth provider and the staff MFA policy.

**X2. No HTTP layer: CSRF, XSS, CORS, security headers, rate limits and SSRF cannot be assessed.**
- Evidence: no server, no app shell, no routes, no `vercel.json` or equivalent, no CSP or CORS
  configuration anywhere in the repo.
- Impact: every write endpoint and every webhook endpoint is unbuilt, so the highest-risk surface is
  unreviewed.
- Remediation: when the app shell is built, require HTTPS only, HSTS, a strict CSP, `frame-ancestors
  'none'`, SameSite cookies, CSRF tokens on state-changing forms, output encoding, rate limits on auth
  and search, body size limits on webhooks, and an allowlist for CORS. Re-audit before launch.

**X3. Dependencies cannot be audited and no lockfile exists.**
- Evidence: `package.json` declares no dependencies and there is no `package-lock.json`.
- Impact: the supply chain is unknown. Adding packages later without a lockfile makes builds and audits
  irreproducible.
- Remediation: once package installs are allowed, add a lockfile, pin versions, run `npm audit`, enable
  Dependabot or equivalent, and review each runtime dependency.

### High

**H3. Money-moving and cancellation functions have no actor check.** `payments.refund()`,
`fulfilment.cancelBooking()`, `placeOrder()` and `captureIfTicketed()` accept no actor and check no
role. The support service gates refunds through permissions and `REFUNDS_DISABLED`, but a direct caller
of these internal functions would bypass that.
- Impact: any future route that calls them directly could refund or cancel without an authorised person.
- Remediation (needs approval, because it changes the function signatures): pass the caller's actor
  into each money-moving function and require a system or support role. Add a unit test per function.

**H4. Payment and fulfilment state is in memory only.** `PaymentStore`, `FulfilmentStore` and the
notification queue are not persisted. The database schema is also missing the columns the code uses
(captured and refunded amounts, intent expiry, intent reference).
- Impact: a restart loses payment intents, idempotency records and the audit trail. Money can be
  orphaned.
- Remediation: add the missing columns and a unique partial index so one live payment exists per
  booking (the database-level form of C2). Persist operations with their idempotency keys. Needs approval
  for the schema change.

**H5. Passenger personal data is visible to all staff and stored unprotected.** The RLS policy
`passengers_select` lets support and admin read every passenger's name, date of birth and nationality.
`privacy.ts` gives support date of birth and nationality, so this matches the code's design. Ticket
numbers are stored in plain text in `tickets.ticket_number`.
- Impact: a support account compromise exposes the personal data of all customers. The NDPA sensitive
  data rules and data minimisation are not met by a single staff role.
- Remediation: restrict staff reads of passenger rows to assigned requests (or to the booking being
  worked on), log every staff read of passenger data to the audit log, encrypt ticket numbers at rest,
  and mask them in staff views. Needs approval (access model).

**H6. Passport and travel document handling has no design yet, but airlines need it.** Travel document
numbers are validated in memory and never stored (correct today). Airlines require passport data for
international ticketing, so the first real order will need it.
- Impact: when the first international order is built, the data flow may be designed under time pressure
  and could store document numbers without the required protections.
- Remediation: before any live order, decide the flow (collect at order time, pass to the airline,
  delete after ticketing, or store encrypted with a retention rule). Counsel must review it (register
  item 1.7). Needs approval.

**H7. The supplier adapter is unverified against a sandbox.** `DuffelFlightSupplier` is marked
"prepared, not verified". Field names come from secondary sources. Production is gated by
`productionApproved`.
- Impact: the adapter could mis-price or mis-read a live offer. The production gate limits exposure, but
  the sandbox check is still a go-live requirement.
- Remediation: run the adapter against the Duffel sandbox with the owner's approval and record the results.

**H8. Payment providers have no verified webhook replay window or timestamp check.** Signature checks
are correct (HMAC SHA-512 for Paystack, constant-time static-hash comparison for Flutterwave), and
replays are blocked by the dedupe key. Neither provider's timestamp rules have been checked against
their documentation.
- Impact: low today, because a valid old event is deduplicated. Still a gap if the dedupe store is lost.
- Remediation: verify each provider's timestamp rules and add a freshness window where the provider
  supports one.

### Medium

**M5. Provider calls do not send an idempotency key.** Paystack `initiate` sends the reference in the body
but not as a header. Whether Paystack honours an idempotency header has not been checked.
- Remediation: verify provider idempotency support in the sandbox. Until then, rely on the in-process
  claim (C2) and the database constraint in H4.

**M6. No retention schedule, data subject request process or breach procedure.** The legal register
items 1.6 (retention), 1.8 (requests) and 1.9 (breach notification) are "Not started".
- Impact: the NDPA obligations cannot be met and data is kept indefinitely.
- Remediation: counsel to set retention periods per data class (bookings, passenger details, payment
  records, support notes, logs). Build an erasure and export process. Needs legal review.

**M7. Customer email is sent to the payment provider.** `initiate` sends the customer's email to
Paystack or Flutterwave, which is required to take payment.
- Impact: a processor relationship and a privacy-notice disclosure are needed before live use.
- Remediation: processor agreements and privacy notice before live payments (register items 1.4, 1.3).

**M8. Supabase RLS has been tested on a shim, not on Supabase.** The database checks pass on PostgreSQL 16
with a shim of `auth.uid()` and the roles.
- Remediation: run `rls_policies.sql` in a Supabase test project with real Auth, including tests that
  use a real JWT.

**M9. Notification and audit persistence.** The notification queue is in memory. Its failure log is
free of personal data (codes only), which is correct, but it is lost on restart.
- Remediation: persist the queue (pg-boss, once installed) and the failure log.

**M10. Duffel response handling.** Invalid `expires_at` values throw a `RangeError` instead of a
`SupplierUnavailableError`, and the response body size is not limited.
- Remediation: validate dates and limit response size before parsing.

### Low

**L1.** `parseDecimalToMinor` does not reject amounts above `Number.MAX_SAFE_INTEGER`. Add a safe-integer
check.

**L2.** `captureIfTicketed` casts the currency with `as 'NGN'`. Use the stored currency with validation.

**L3.** `cancelUnpaidOrder` takes a `nowUtc` argument it does not use. Remove it.

**L4.** The payment audit log is in memory. Persist it with append-only enforcement (as in the
`audit_log` table).

## 5. Positive findings

- No live secrets are committed. The only key-like strings are test placeholders such as `sk_test_x`.
- No `eval`, `new Function`, `innerHTML`, shell execution or dynamic SQL in the code.
- No console logging of personal data.
- Booking references come from `crypto.randomBytes`, not `Math.random`.
- Webhook signatures are verified over the raw body before parsing. Comparisons are constant time.
  The provider status is fetched before any state change, so webhook bodies are never trusted alone.
- Production gates exist for Paystack, Flutterwave, Duffel and ticketing, and default to off.
- The RLS policies deny anonymous access, let customers read only their own rows, deny customer
  writes to bookings, payments and tickets, and prevent a customer from changing their own role.
- The audit log is append-only, enforced by a trigger, and now also protected against `TRUNCATE`.
- Travel document numbers are not stored. Passenger validation and role-based views are in place.
- `scripts/test-db.sh` refuses to run against any database whose name lacks "test".

## 6. Nigerian and international legal review (for qualified counsel)

These are issues for counsel. They are not legal conclusions. Counsel should confirm the current text of
the Nigeria Data Protection Act 2023 and its implementing directive, and any applicable international
rules for customers travelling abroad.

1. **Data controller and processor roles** for GO, Duffel, the payment providers, the email provider
   and hosting (register 1.1, 1.4).
2. **Lawful basis and privacy notice** before any collection (1.2, 1.3).
3. **Sensitive data**: passport and date of birth. Whether the processing needs explicit consent or
   another basis, and how it is secured (1.7, H5, H6).
4. **Cross-border transfers**: passenger data goes to airlines abroad, and hosting and email may be
   outside Nigeria (1.5, 4.5). Counsel should assess the transfer basis and data localisation duties.
5. **Retention schedule and erasure**, which must balance tax and dispute records against deletion
   duties (1.6, M6).
6. **Data subject rights**: access, correction, deletion and objection, with response deadlines (1.8).
7. **Breach notification** to the regulator and customers, with timelines (1.9).
8. **Data protection officer** appointment (1.10).
9. **Advance passenger information**: destination countries may require passenger data before travel.
   Airlines and destinations determine what must be sent (4.5).
10. **Payment card data**: GO stores no card data and uses hosted redirect checkout. The card compliance
    scope (for example SAQ A) must be confirmed with each provider and counsel.
11. **Consumer protection and refunds**: refund rules and the GO refund fee need legal approval before
    customers are charged (docs/06, owner decisions).

## 7. Remaining decisions for the owner

- Approve the design for H3 (actor checks on money-moving functions).
- Approve the database schema work for H4 (missing columns, unique live-payment index).
- Approve the staff access model for H5 (assignment-based access, logging of passenger reads).
- Approve the passport data flow for H6 before any international order is built.
- Approve the auth provider and the staff MFA policy for X1.
- Approve creation of a lockfile and dependency policy (X3) when installs are allowed.
- Engage counsel for the section 6 items (existing owner decision: counsel firm choice).

## 8. Launch checklist (all must be true before production)

- [ ] Authentication, session, reset and MFA implemented and tested (X1).
- [ ] HTTP layer hardened and re-audited (X2).
- [ ] Lockfile, dependency audit clean, and dependencies reviewed (X3).
- [ ] Actor checks on all money-moving functions (H3).
- [ ] Payments and fulfilment persisted with idempotency keys and a one-live-payment constraint (H4, C2 at database level).
- [ ] RLS verified on a real Supabase project with real JWTs (M8).
- [ ] Passenger data access restricted, logged and encrypted where required (H5).
- [ ] Passport data flow approved and reviewed by counsel (H6).
- [ ] Duffel sandbox verification recorded (H7).
- [ ] Provider sandbox checks for webhook timestamps and idempotency (H8, M5).
- [ ] Retention, erasure, data subject requests and breach procedure in place (M6).
- [ ] Privacy notice, processor agreements and transfer assessment complete (M7, section 6).
- [ ] Production build passes on a machine where package installs work.
- [ ] Owner approval of each production gate: payments, ticketing, cancellation, refunds.
