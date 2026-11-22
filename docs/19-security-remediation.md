# 19. Security remediation (Phase 14 follow-up)

Status: the six approved engineering decisions are implemented and tested where they can be tested
in this environment. GO is NOT production-ready. Several controls depend on services that have not
been set up (a Supabase project, a Duffel sandbox token, a deployed HTTPS origin), and the
Nigeria Data Protection Act review is still open. Passing tests is not production readiness.

Nothing was purchased, no account was created, no live service was called, nothing was committed or
pushed. Payments, ticketing, cancellation and crypto remain disabled.

## 1. Results

Verification: 518 of 518 unit tests pass (`npm run test:unit`). The database checks pass on a local
PostgreSQL 16 cluster (`scripts/test-db.sh` as the postgres user), including the new checks 16 to 19.
A mutation test confirmed the one-live-payment check fails when the index is removed.

| Finding (from doc 18) | Status | Evidence |
| --- | --- | --- |
| C1 airline paid the wrong amount | Fixed (phase 14) | fulfilment regression test |
| C2 duplicate payment sessions | Fixed in memory, and enforced in the database | `payments_one_live_per_booking` index; check 16; mutation test |
| H1 lost webhook confirmations | Fixed (phase 14), durable dedupe added | `payment_webhook_events` table; check 17 |
| H2 cancellation without owner gate | Fixed (phase 14) | fulfilment regression test |
| H3 no actor checks on money functions | Fixed | `packages/auth/src/actor.ts`; 7 authorisation tests; 3 end-to-end tests |
| H4 payment schema mismatch | Schema aligned; persistence still in memory | migration `20261119000000`; check 15 |
| H5 staff see all passenger data | Fixed in the database; passenger data still plain in the table | `staff_passenger_details()`; checks 19a to 19h |
| H6 passport data flow undefined | Architecture built; collection disabled | `packages/passport`; order gate; tests |
| X1 no authentication layer | Verifier and actor model built; Supabase project not configured | `packages/auth/src/token.ts`; 38 + 7 tests |
| X2 no HTTP layer | Baseline built and tested as a library; no deployed app | `packages/http`; 43 tests |
| X3 no lockfile | Fixed: lockfile, pinned exact versions, `npm ci` verified | `package-lock.json`, `.npmrc` |
| M4 payment constraints drift | Fixed | migration; check 15 |
| Tickets stored in plain text | Fixed in the schema; app encryption module built | ciphertext columns; check 18; `packages/security` |
| Intent reference reused across attempts | Fixed | payment regression test |

## 2. Decision by decision

### 1. Server-side actor and permission checks (done)
- `packages/auth/src/actor.ts`: an `Actor` is either a verified user (role, MFA flag) or a named
  internal service. `authorise()` denies by default. Each money action names the only services or roles
  allowed to perform it.
- Every money-moving entry point now takes an actor and checks it before any state change:
  `startPayment`, `captureAfterFulfilment`, `releaseAfterSupplierFailure`, `refund`, `placeOrder`,
  `pollTicketing`, `captureIfTicketed`, `cancelBooking`.
- Each authorised action writes an audit entry naming the actor (for example `system:payments` or
  `user:<id>`). The label never contains a token or an email address.
- A customer can start a payment only on a booking they own. A customer cannot place, capture,
  refund or cancel. Staff cancellation and refunds require an MFA session.
- Identity comes from a verified token (`packages/auth/src/token.ts`) and the role from the
  database, never from the token or the request body.

### 2. Payment schema and one live payment per booking (done, database verified)
- Migration `20261119000000_phase14_security.sql`: `payments` gains `reference` (unique), `expires_at`,
  `captured_minor`, `refunded_minor`, with amount and refund constraints. The unused
  `processed_event_ids` column is removed.
- A partial unique index allows only one row in a live state per booking. The live set matches
  `LIVE_STATUSES` in the code. Concurrent inserts cannot both succeed.
- Each payment attempt gets its own reference, so a retry after a failure does not reuse the
  provider idempotency key (application fix, with a regression test).
- `payment_webhook_events` makes webhook deduplication durable. No client role can read or write it.
- The migration refuses to run if `payments` or `tickets` already contain rows. Nothing is live yet,
  so this is safe, but it must be revisited before any data exists.

### 3. Assignment-based staff access, read logging and encryption (done in the database and module; not yet wired to an application)
- `support_assignments` records which staff member may see which booking. Only server code creates or
  revokes assignments.
- `staff_passenger_details(booking_id)` is the only staff path to passenger data. It requires an MFA
  session and an active assignment for every staff member, including admins. It writes an entry to
  `passenger_access_log` before returning data. The log is append-only.
- Direct table reads of passengers by staff return nothing.
- Ticket numbers are stored only as ciphertext (`v1.<key id>.<iv>.<tag>.<ciphertext>`), bound to the row
  with additional data, plus an HMAC for duplicate detection. There is no plaintext column.
- `packages/security/src/field-crypto.ts` provides AES-256-GCM with key rotation and no key defaults.
  Keys must be injected by the caller. No key management service has been set up.

Not yet done: passenger date of birth and nationality are still plain text in the table. Encrypting
them needs the same key process, and that decision is listed below.

### 4. Passport data architecture (architecture built, collection disabled)
- Duffel's public documentation (the orders page and changelog, fetched this session) shows an
  `identity_documents` array with type, unique identifier, issuing country and expiry, and says passport
  data is optional for some airlines. The documentation did not confirm which airlines or routes
  require it. The Duffel adapter does not set an identity requirement, so every offer is "unknown".
- `Offer.identityDocumentRequirement` is an explicit field, absent by default. Only a supplier
  statement sets it. Unknown never triggers collection.
- `placeOrder` refuses to order an offer marked `required`, and records why. Nothing is sent to an
  airline without the data the airline requires.
- `packages/passport`: `collectionDecision()` (unknown and not-required never collect; optional needs
  consent), `validatePassport()` (document type restricted to passport, expiry must be after travel),
  and `PassportVault` (AES-256-GCM encryption, purpose-restricted reads, purge on schedule, access log
  with no personal data). Retention has no default: the vault refuses to start without it.
- `passportLogFields()` omits the number. The `safeLogFields()` allowlist redacts emails and
  document-like values.
- Not done: no retention value has been set (counsel must decide), the purge is not scheduled, the
  vault is in memory, and no document flow reaches a supplier. These are deliberate blockers.

### 5. Supabase Auth, MFA and sessions (code and policy done; Supabase configuration NOT done)
Implemented in code and tested:
- `verifyAccessToken()`: HS256 with a configured secret, or ES256/RS256 with a configured public key.
  Rejects `none`, algorithm confusion, expired, not-yet-valid, wrong issuer, wrong audience and a role
  other than `authenticated`. Only the claims needed are returned.
- `actorFromVerifiedClaims()`: staff are MFA-verified only if `aal` is `aal2` and the session is no older
  than a configured limit (there is no default limit).
- RLS: every staff policy now requires `aal2` (`is_staff_mfa()`, `is_admin_mfa()`). Test 8 proves that
  staff without MFA see nothing.

Not done, and needs your approval and a Supabase project:
- Creating and configuring the Supabase project: MFA enforcement for staff accounts, email
  confirmation, password recovery, session lifetime, redirect URLs and auth rate limits. None of these
  have been verified, because creating a project is an account action I have not taken.
- The real JWT format, signing keys and the `email_verified` claim must be checked against the
  project. The verifier is built to the documented claim names but has not been run against a real token.
- Customer MFA stays optional, as you approved.

### 6. npm, lockfile and reproducible installs (done)
- `package-lock.json` is committed-ready (lockfile version 3). The project has no runtime dependencies,
  so the lockfile is minimal and every dependency added later must be pinned.
- `.npmrc`: exact saves, `engine-strict`, no funding prompts, `ignore-scripts` so install scripts never
  run by default, `audit`.
- `npm ci` was run and succeeded from the lockfile. `npm run test:unit` runs all 518 tests through npm.
- `npm run audit` exists. In this environment the audit reported 0 vulnerabilities for a tree with no
  dependencies, so it proves nothing yet. It must be run again after the first real dependency is added.

## 3. HTTP application security baseline (library tested; not deployed)

`packages/http` provides, as tested code:
- security headers: a strict Content-Security-Policy for an API, frame denial, no-sniff,
  no-referrer, a restricted permissions policy, `Cache-Control: no-store`, and HSTS only when the
  request is over HTTPS;
- CORS with an exact-match origin allowlist, no wildcard, no reflection of unlisted origins, and
  `Vary: Origin`;
- CSRF: cross-site unsafe requests are refused, an unsafe request with a foreign origin is refused,
  and cookie-based sessions must present an allowed origin. Bearer-token requests are exempt, which is
  correct because browsers do not attach bearer tokens automatically. This exemption must be kept in
  mind when the app is built;
- a fixed-window rate limiter that returns 429 with `Retry-After`;
- a body size limit (413), invalid JSON (400), generic 500 responses with no stack trace, 404 and 405.

Not verified and not in place:
- HTTPS, TLS and HSTS in a real deployment. Only the header value is tested.
- Rate limiting is in memory and single-instance only. Behind a load balancer it needs a shared store and
  a trusted proxy setting. X-Forwarded-For is ignored on purpose until that setting exists.
- Token verification is not wired into the server. Handlers must call `verifyAccessToken()` themselves,
  so no route is protected until the app is built.
- There is no application shell yet, so no XSS review of rendered pages is possible.

## 4. Blockers and what I need from you

1. **Supabase project (approval needed).** Creating a project is an account action. Once approved, I
   will configure and test MFA enforcement, email verification and recovery, session settings and the
   real token format.
2. **Duffel sandbox access (approval needed).** The adapter cannot be checked without a sandbox token,
   which requires the Duffel account and an approved business. I have not requested or purchased
   anything. Once you approve access, I will run the sandbox checks and record the results.
3. **Retention periods and the passport decision (counsel).** No retention period has been set, and
   nothing has been assumed. Counsel must set retention by data class and decide whether passport data
   is stored at all. Collection stays off until then.
4. **Key management (approval needed).** Field encryption needs keys held outside the repository. The
   options (a managed key service, or a secrets store) carry costs or accounts, so they need your
   approval first.
5. **Passenger data at rest.** Decide whether passenger date of birth and nationality are encrypted like
   ticket numbers.
6. **Persistence.** Payments, fulfilment and the notification queue are still in memory. Making them
   durable is the next engineering step, and it needs the schema work confirmed.

## 5. Legal review (still open)

The Nigeria Data Protection Act 2023 review in doc 10 (items 1.1 to 1.11, and 4.5) is still open. This
engineering work is not legal compliance. Counsel must confirm lawful basis, privacy notice,
processor agreements, cross-border transfers, retention, data subject rights, breach notification and
whether a data protection officer is required. Passport handling in particular needs counsel's review
before any collection.

## 6. Files changed

- New: `packages/auth/src/actor.ts`, `packages/auth/src/token.ts`, tests in `packages/auth/test/`;
  `packages/http/` (six modules and a test file); `packages/security/` (two modules and two tests);
  `packages/passport/` (three modules and a test); `supabase/migrations/20261119000000_phase14_security.sql`;
  `package-lock.json`; `.npmrc`; this document.
- Changed: `packages/payments/src/payment-flow.ts`, `store.ts`, `webhook.ts`; `packages/fulfilment/src/orchestrator.ts`;
  `packages/flights/src/supplier.ts` (identity requirement field); `supabase/tests/00_supabase_shim.sql`
  (adds `auth.jwt()`), `supabase/tests/rls_policies.sql` (checks 8, 15 and new 16 to 19);
  payment and fulfilment tests; `package.json` (test list, `audit` and `ci` scripts).

## 7. Supabase development project (owner decision 1, executed 2026-11-19)

- Project `go-dev-free` (ref `gghsvzighgqqamibjywu`), region eu-west-2 (London), organisation on the free tier.
  Status ACTIVE_HEALTHY, PostgreSQL 17. No paid add-on, subscription or billing commitment was made.
  Region is a data residency question for counsel.
- Migrations applied to the project as stored in the repository: `20261112000000_initial_schema.sql`,
  `20261119000000_phase14_security.sql`, and `20261119120000_function_hardening.sql` (new). The project
  schema was reset once, before any data existed, because a first attempt had typed the initial schema
  from memory instead of applying the file. The reset was on this project only.
- Advisors (security): `anon` can no longer execute any function in `public`. The trigger functions are not
  callable by signed-in users. `prevent_audit_mutation` has a fixed search path. Remaining findings are
  intended: `payment_webhook_events` has RLS with no policies (service role only, INFO), and
  `current_app_role`, `is_staff_mfa`, `is_admin_mfa` and `staff_passenger_details` stay executable by
  signed-in users because RLS policies and the staff access path call them. Each checks the caller itself.
- Local checks after adding the hardening migration: `scripts/test-db.sh` passes (all RLS and constraint
  checks). Unit tests: 518 of 518.
- Not verified: real JWT format and `aal` claim from Supabase Auth, MFA enforcement settings, email
  confirmation, session lifetime, redirect URLs and auth rate limits. These are Supabase dashboard
  settings and have not been configured or tested. Nothing was run against live customer data.
- Still blocked: Duffel sandbox (owner must create the account), envelope encryption and KMS (owner
  approval of key management), passenger date of birth and nationality encryption, nationality removal,
  durable payment and fulfilment state in PostgreSQL, and the NDPA counsel review.
