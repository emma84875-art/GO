# Phase 19.2: operation ledger, payment authority and write-ahead payment start

Status: Phase 19.2 complete for the local scope defined here, after the final review in section 7A. Checked locally. Not
committed, not pushed, not merged, not deployed. Live integrations are off. This does not make the system production-ready:
the production blockers are in sections 8 and 9, and they must close before live use. Awaiting owner review.
Builds on: docs/24 (decision record) and docs/25 (Phase 19.1 schema risks and payment controls).

## 1. What this phase protects

Some operations change the outside world: a supplier order, a supplier cancellation, a payment start, a payment capture
request. A retry, a duplicate request or a crash must never make one of them happen twice. An operation whose outcome is
unclear must never be sent again on a guess. The operation ledger decides this, and the Phase 19.1 PostgreSQL model is
the single authoritative record of a payment.

## 2. Decisions taken in this phase

1. **One payment authority.** The Phase 19.1 `public.payments` and `public.bookings` tables, and their functions, are the
   only authoritative record of a payment. The application writes to them only through `public.app_payment_*` functions,
   which call the 19.1 rules. The application holds no payment state in memory or in any other table.
   The earlier design, with application-owned durable tables (`app_fulfilment_*`, `app_payment_intents`,
   `app_payment_audit`, `app_payment_webhooks`), was removed. Its migration, rollback, SQL checks and TypeScript state
   module were deleted, so nothing in the repository still implements it.
2. **Write-ahead payment start.** A payment start records its intent in the database before the provider is called, and
   records the provider's answer afterwards. An uncertain outcome is recorded as `unknown`. An `unknown` start is
   resolved only by reconciliation from provider evidence. The application never starts a second payment automatically
   after an uncertain result.
3. **Passenger data.** Names and dates of birth are encrypted before any live use. The encryption primitive exists.
   Nothing yet writes passenger data to storage, because booking persistence is not built (section 6). The Phase 19.1
   `passengers` table still holds plaintext and must not be used for live data.
4. **Local executor.** The `psql` executor stays a temporary local testing adapter. No paid infrastructure was added.
   The `pg` driver could not be installed, because the npm registry is unreachable from this environment.
5. **Final review of two reported issues.** (a) The one-live-payment index omitted `capture_requested`. It now matches
   `LIVE_STATUSES`. (b) The service role could change `amount_minor`, `currency`, `booking_id`, `reference`,
   `provider_reference`, `refunded_minor` and a booking's price, and could delete payments and bookings and truncate both
   tables. Each path is now refused by a guard in `20261130000000_payment_guards.sql`, and the service role no longer has
   TRUNCATE on the two tables. Section 7A records the evidence before and after.
6. **Supplier operations use the ledger.** The supplier execution path is `packages/fulfilment/src/orchestrator.ts`
   (`placeOrder`, `cancelBooking`, `captureIfVerified`). Each supplier order, supplier cancel and capture request begins a
   persistent ledger operation before the external call, and records its result after it. The in-memory operation log
   (`recordOperation`, `operation`) is no longer used by the orchestrator, so nothing in memory decides whether an external
   request was sent. The earlier store version tracking and the ledger-gated changes inside the legacy in-memory payment
   flow were not restored. Capture is gated by a wrapper in the orchestrator, and `payment-flow.ts` is unchanged.

## 3. What is implemented

| Part | Status | Where | Proven by |
| --- | --- | --- | --- |
| Operation ledger tables, constraints, transition guard, one live operation per subject | Implemented in the database | `supabase/migrations/20261127000000_operation_ledger.sql` (generated) | `supabase/tests/operation_ledger.sql` (63 labelled checks in the run) |
| Ledger types include `payment.start` (external, subject-unique) | Implemented. The generator regenerates the migration. | `packages/operations/src/ledger.ts`, `scripts/generate-operation-ledger-sql.mjs` | generator check in `scripts/test-db.sh` |
| Ledger functions `begin_operation`, `complete_operation`, `renew_operation_lease`, `reconcile_operation` (service role only) | Implemented. Lease time is the database clock. | same migration | `operation_ledger.sql`; concurrency script |
| Ledger rollback (refuses while any operation is recorded) | Implemented | `supabase/rollbacks/20261127000000_operation_ledger.down.sql` | round trip in `scripts/test-db.sh` |
| Ledger concurrency | Implemented (advisory locks, row locks, unique index) | ledger functions | `scripts/test-ledger-concurrency.sh`: 24 parallel sessions, one start, 23 stale completions rejected |
| PostgreSQL ledger adapter `PostgresOperationLedger` | Implemented. Calls the ledger functions. | `packages/operations/src/postgres-ledger.ts` | adapter unit tests; ledger integration tests (12) |
| Payment authority functions `app_payment_start`, `app_payment_bind_reference`, `app_payment_load`, `app_payment_find_by_reference` (service role only) | Implemented. The start creates an `initiated` row only, for a `quoted` booking, with a placeholder provider reference. The bind is one-way. | `supabase/migrations/20261129000000_payment_authority.sql` (hand-written) | `supabase/tests/payment_authority.sql` (checks A to J); round trip in `scripts/test-db.sh` |
| Authority rollback (drops the four functions only) | Implemented | `supabase/rollbacks/20261129000000_payment_authority.down.sql` | round trip in `scripts/test-db.sh` |
| 19.1 guards (the status guard is unchanged; the live index is replaced in section 7A) | `guard_payment_state`, `payments.reference` unique, `request_payment_capture`, `apply_payment_provider_event`, `payment_provider_events` append-only | `supabase/migrations` (Phase 19.1) | `rls_policies.sql`, `booking_lifecycle.sql` |
| Authority adapter `PostgresPaymentAuthority` | Implemented. Holds no state. Escapes all SQL through `sqlText`. | `packages/payments/src/authority.ts` | unit tests with a fake authority |
| Write-ahead start, reconciliation and webhook flow | Implemented | `packages/payments/src/durable-flow.ts` | 10 integration tests (section 9) and unit tests |
| Provider contract `findByReference` (used only to reconcile an uncertain start) | Added to the interface (optional) and to the fixture | `packages/payments/src/provider.ts`, `packages/payments/src/adapters/fixture.ts` | unit and integration tests |
| Composition root `startApplication` and `Application` | Implemented. Fails closed if the database is unreachable or a required function is missing. Holds no state. | `packages/app/src/application.ts` | `packages/app/test/app.unit.test.ts` (includes a source guard that the root does not import the legacy in-memory payment, webhook, store or fulfilment modules) |
| Passenger field encryption primitive `PassengerVault` | Implemented. Encrypts first name, last name and date of birth with `FieldCrypto`, bound to booking, passenger index and field. Strict date round trip. Keys are injected, never read from the database. | `packages/app/src/passenger-vault.ts` | `packages/app/test/passenger-vault.unit.test.ts` |
| Test provider that keeps state in a file | Implemented (test-only) | `packages/app/test/fixtures/file-provider.ts` | integration tests across restarts |
| Review fixes: live index equal to `LIVE_STATUSES`; immutable payment fields; refund rule; booking price lock; delete guards; no TRUNCATE for the service role | Implemented (section 7A) | `supabase/migrations/20261130000000_payment_guards.sql`; rollback `supabase/rollbacks/20261130000000_payment_guards.down.sql` | `supabase/tests/payment_guards.sql`, in the build and after each round trip in `scripts/test-db.sh`; mutation checks (section 10) |
| Live index equal to `LIVE_STATUSES` (drift check) | Implemented | `packages/payments/test/live-index.unit.test.ts` | reads the latest index definition from the migrations and compares it with `LIVE_STATUSES` |
| Supplier order, supplier cancel and capture request use the persistent ledger (`supplier.order`, `supplier.cancel`, `payment.capture_request`). Fail closed: a ledger error sends nothing. An unclear outcome is recorded as `unknown` and is never sent again automatically. An attempt that stops before the external call is recorded as `failed_retryable` or `failed_terminal`. | Implemented in the orchestrator. Booking state stays in memory and is not authoritative. | `packages/fulfilment/src/orchestrator.ts`; `FulfilmentDeps` now requires a `ledger` | `packages/operations/test/postgres-ledger.integration.test.ts`: the six supplier-order tests (fail closed, eight concurrent calls send one order, crash after the order is sent, retry after success, capture before a crash, lost cancellation reply), each restart in a separate process; `packages/fulfilment/test/fulfilment.test.ts` (30 unit tests with `MemoryOperationLedger`) |

Deleted in this phase: `supabase/migrations/20261128000000_app_durable_state.sql`, its rollback,
`supabase/tests/app_durable_state.sql`, `packages/app/src/state.ts`, and `packages/app/test/state.unit.test.ts`.

The legacy in-memory modules (`packages/payments/src/payment-flow.ts`, `webhook.ts`, `store.ts`,
`packages/fulfilment/src/orchestrator.ts`, `store.ts`) are not connected to the application and must not be connected
without a new decision. Their tests still run as unit tests.

## 4. Payment start: write-ahead sequence

`startPaymentDurable` runs these steps. Each external effect has one ledger row, keyed by the payment reference.

1. **Ledger begin** (`payment.start`, subject = booking). A lease is granted for `PAYMENT_START_LEASE_SECONDS` (300 by
   default; a guess, section 8). A held or unknown operation stops the start here.
2. **Authority start.** `app_payment_start` inserts an `initiated` payment with the placeholder provider reference
   `pending:<reference>`. The 19.1 one-live-payment index and the unique reference both still apply. A repeat with the
   same reference returns the same payment and creates no second row.
3. **Provider initiate, once.** The provider is called once, in `authorise` mode, with the reference as its idempotency
   key.
4. **Bind.** `app_payment_bind_reference` records the provider's reference. The first bound value is final.
5. **Ledger complete.** The ledger records `succeeded`, with the payment id as the result reference.

If the provider call returns an error, or any step after it fails, the ledger records `unknown`. The start then stops.
A later start returns `needs_reconciliation` and sends nothing to the provider.

## 5. Recovery matrix

| Interruption | What happens next | Can the provider be called again automatically? |
| --- | --- | --- |
| Crash or error before step 3 | The lease expires, or the operation is recorded as failed. The authority row, if any, is an `initiated` row with no provider reference. A later start reuses it. | No provider payment exists yet. A new attempt is allowed only after the ledger allows it. |
| Crash after the provider accepted, before the bind | The lease expires; the ledger records `unknown`. Reconciliation calls `findByReference`. If the provider holds a payment, the reference is bound and the ledger completes. If the provider holds nothing, reconciliation records `failed_retryable` and one new attempt is allowed under the same key. | Never by the start path. Only after provider evidence. |
| Bind done, crash before ledger complete | Next start finds the bound payment and completes the ledger without calling the provider. | No |
| Provider returns an error, or the reply is lost | Recorded as `unknown` (not `failed`). Not initiated again until reconciled. | No |
| Two processes start the same payment | The ledger allows one; the other sees `in_progress` or the recorded result. Tested with two processes. | No |
| Provider webhook arrives for an unknown reference | Signature is checked first. Unknown references are recorded as rejected, with placeholder ids, and change nothing. | Not applicable |

Payment capture (`request_payment_capture`), release and refund are not wired to the application (section 8).

## 6. Booking and passenger data

- **Booking creation is not built.** The application can start a payment only for a `public.bookings` row that is already
  in `quoted` state, and the tests create such rows directly. No code creates a booking, links it to a profile, or
  stores passengers.
- **Passenger minimisation.** The application stores no passenger data in any table. The Phase 19.1 `passengers` table
  still holds plaintext names, dates of birth and nationality. It has a comment saying encryption is required before
  storage. It is not used by the application and must not receive live data until it is migrated to ciphertext.
- **Encryption primitive.** `PassengerVault` encrypts the three personal fields with separately bound associated data,
  so a ciphertext cannot be moved to another passenger, booking or field. Decryption checks the round trip, so a
  rolled-over date such as `1990-02-31` is refused.

## 7. Security and transaction review

- **SQL construction.** Every value sent to the database goes through `sqlText`, which doubles single quotes and refuses NUL
  bytes. No string is concatenated unescaped in the application.
- **Privileges.** Payment authority and ledger functions are `security definer` with `search_path = public, pg_temp`, and
  executable only by `service_role`. Anonymous and signed-in roles are refused (authority checks J; ledger checks N1, N2).
- **Transactions.** Each authority function is one statement or one function call. The ledger writes are separate
  auto-committed statements by design, so an external effect is recorded even when a later write fails. The recovery
  matrix depends on this.
- **Guard coverage.** A payment is created only as `initiated` with zero captured amount. Status changes need
  `go.payment_authority`, set only by `request_payment_capture` or `apply_payment_provider_event`. Since the final review
  (section 7A), the booking, provider, reference, amount and currency of a payment never change, its provider reference
  changes only through the bind function, and its refunded amount changes only from a verified provider event. A payment is
  never deleted. A booking is deleted only as a draft, and a booking's price and currency are fixed once it leaves draft.
- **Review items, open.**
  - The service role can still write the other columns of `bookings` (for example `supplier_amount_minor`,
    `supplier_order_id`, `fx_rate` and `offer_snapshot`) without a guard. No code writes them yet. They need guards before
    the booking integration is built.
  - `payments.updated_at` is writable by the service role without a guard. It is not a financial field.
- **Error detail.** The `psql` executor attaches psql's error output to `detail`, and that output can include fragments of
  a statement. Nothing in the application logs `detail`, and nothing may log it in future.
- **Webhooks.** The signature is verified before any event is recorded or acted on. A duplicate event is recognised by the
  19.1 processed-once index. Event ids include the booking id in tests.

## 7A. Final review: the two reported issues

**Issue 1. Live-payment index and live-state definitions.** The 19.1 index covered `initiated`, `authorised`, `captured`,
`refund_pending` and `review_required`. It left out `capture_requested`, although `LIVE_STATUSES` in
`packages/payments/src/state.ts` includes it. A booking could therefore hold a `capture_requested` payment and a second
live payment at the same time. The migration `20261130000000_payment_guards.sql` replaces the index with exactly the six
`LIVE_STATUSES`. The database check `payment_guards.sql` (Part A) places each status with triggers off and then tries a
second live payment. The unit test `live-index.unit.test.ts` compares the index definition with `LIVE_STATUSES`.

**Issue 2. Service-role updates, deletes and transition guards.** Before this change, a probe as the service role, in a
rolled-back transaction, changed `amount_minor` of a live payment to 1, changed its `provider_reference` to a value the
provider had not issued, and changed a quoted booking's display amount to 1. All three succeeded. The 19.1 status guard
checks only status, captured amount, settlement and capture timestamp, and it returns early when those are unchanged, so
other columns were not checked. The service role also held DELETE and TRUNCATE on both tables, and no trigger covered
either. The fix, in `20261130000000_payment_guards.sql`:

| Path | Before | After |
| --- | --- | --- |
| Live index with a `capture_requested` payment | A second live payment was allowed | Refused (unique violation) |
| Service role changes `amount_minor`, `currency`, `booking_id` or `reference` | Allowed (probe) | Refused (SQLSTATE 23514) |
| Service role changes `provider_reference` outside the bind function | Allowed (probe) | Refused (SQLSTATE 23514) |
| Bind function sets the provider reference once | Allowed | Still allowed. It now sets the authority `bind` for its one update. A second, different value is refused. |
| Service role changes `refunded_minor` without a verified provider event | Allowed (no trigger covered the column, from reading the 19.1 trigger; not probed) | Refused, with the refund message |
| Service role changes a quoted booking's `display_amount_minor` or `display_currency` | Allowed (probe) | Refused (SQLSTATE 23514) |
| Draft booking price | Allowed | Still allowed |
| Service role deletes a payment | Privilege held; no guard | Refused, with the payment message |
| Service role deletes a quoted booking | Privilege held; no guard | Refused. Draft bookings can still be deleted. |
| Service role truncates `payments` or `bookings` | Privilege held | Refused (SQLSTATE 42501). The owner of the database still can. |
| Amount change under a provider authority | Allowed | Refused. Authority allows status changes only. |
| Status change or captured amount without an authority (19.1 behaviour) | Refused | Still refused (regression check) |

Guard evidence: the new file `supabase/tests/payment_guards.sql` (Parts A to E) fails if the guard it checks is disabled.
Checked by running a copy with the immutability trigger disabled (fails at C1), with the payment delete trigger disabled
(fails at E1), and with TRUNCATE granted back to the service role (fails at E3).

Two defects in the checks were found and fixed during this review. Both are recorded because they would have hidden a
failure: (a) the first version of the check helpers returned without error when the statement succeeded, so a missing guard
would have passed. Each helper now fails when the statement succeeds. (b) The first version used test ids that are not
valid UUIDs, so Part B never ran. Ids are now full UUIDs.

Existing check changed: `rls_policies.sql` check 15 deleted its own test row. It now removes that row as the owner with
triggers off, because payments are never deleted in production. Its assertions are unchanged.

## 8. Remaining work (not implemented)

These block live use. Do not describe the system as complete until they are closed.

1. **Booking integration.** Booking creation, the UUID booking identity, the profile link, the passengers and the tickets
   are not persisted by the application. Payment start requires a pre-existing quoted booking row.
2. **Capture, release and refund.** The application does not call `request_payment_capture` (database). The orchestrator's
   capture is gated by the ledger, but the capture itself, its confirmation, and the release and refund steps still run through
   the in-memory payment flow (`payment-flow.ts`). Release after a supplier failure and refund on cancellation (`payment.refund`) are not ledgered.
   The legacy in-memory capture path must not be wired to live money.
2a. **Fulfilment booking state is in memory.** `FulfilmentStore` is a fixture store. A restart loses booking status, order id
   and documents. Only the operation ledger is durable. Booking persistence is item 1.
3. **Passenger storage.** The 19.1 `passengers` table needs a ciphertext migration, and the application needs a path that
   writes through `PassengerVault`. Key management is not built (section 9).
4. **Local executor.** `psql` is a temporary local testing adapter, starting one process per statement. Replace it with
   the `pg` driver once the npm registry is reachable, and review the replacement. The composition root takes the
   executor as an input, so the replacement does not change the ledger, authority or application logic.
5. **Fixture provider.** The fixture keeps its state in a file for tests. Production-facing code still names only the
   provider interface. A live provider must implement `findByReference` and an idempotent `initiate` before use.
6. **Reconciliation workflow.** The database function and the application function are tested. Nothing calls them on a
   schedule or from an operator tool.
7. **Lease lengths.** 300 seconds is a guess. Measure against real provider response times before live use.
8. **Other booking columns.** Guard the service role's remaining writes to `bookings` (section 7) before the booking
   integration is built. The live index divergence is closed (section 7A).
9. **No live caller.** No HTTP route, job or worker calls the composition root.
10. **Concurrency coverage.** Tested with 24 parallel ledger sessions and two processes racing to start one payment. Not measured under load.

## 9. Conditions that must be met before live use

All of these are required. Owner approval is also required.

1. Booking integration complete: booking creation, profile link, passengers and tickets persisted through the authority,
   with no application-owned payment state.
2. Passenger personal fields stored only as ciphertext, using `PassengerVault` or an approved equivalent, with the 19.1
   `passengers` table migrated. Plaintext storage must not be enabled in production.
3. Key management in place: encryption keys held outside PostgreSQL (a managed key service or equivalent), with the key
   ids recorded beside each ciphertext, a rotation procedure using the keyring, access limited to the backend service
   role, and no logging of decrypted personal fields.
4. The `pg` driver replaces `psql`, and the replacement is reviewed and tested with the full suite.
5. Capture path on the database authority: `request_payment_capture` only after independent ticket verification, and
   the capture recorded only from provider confirmation. The live index matches `LIVE_STATUSES` (section 7A).
6. Reconciliation runs against the live provider, and an operator workflow exists for `unknown` operations.
7. Lease durations measured and set.
8. A live provider implements `findByReference` and an idempotent `initiate`, and that behaviour is tested against the
   provider's documentation or sandbox, with owner approval for any live call.
9. The owner approves the change set, and it is reviewed before any commit, push, merge or deploy.

## 10. How the checks ran

Run on 28 November 2026 against the disposable database `booking_test`, as the operating-system `postgres` account.

Supplier-path verification (latest run, after the orchestrator was moved onto the ledger):
- `scripts/test-db.sh`: exit 0. `postgres-ledger.integration.test.ts`: 12 of 12 pass, including the six supplier-order tests.
  Those tests were not edited. `application integration`: 10 of 10 pass.
- `npm run test:unit`: 1001 pass, 0 fail. `packages/fulfilment/test/fulfilment.test.ts`: 30 of 30 pass with `MemoryOperationLedger`.
- `npm run build:web`: exit 0.

- `npm run test:unit`: 1008 tests pass, 0 fail (987 before this phase's authority work; 1006 after it; 2 added by the
  final review, the live-index drift check).
- Final review, database: `scripts/test-db.sh` exit 0 after the guard migration. The guard checks run in the build (Parts A
  to E) and after the authority and lifecycle round trips. The guard rollback is included in the round trip, and its
  triggers are confirmed gone before the migration is re-applied.
- Final review, mutation checks: a copy of `payment_guards.sql` run with the immutability trigger disabled fails at C1; with
  the payment delete trigger disabled it fails at E1; with TRUNCATE granted to the service role it fails at E3. Each check
  was run against a database that was then rebuilt.
- `scripts/test-db.sh`: exit 0. Output: "Database checks passed."
  - generator checks: lifecycle and ledger migrations up to date;
  - build of every migration in order, including `20261129000000_payment_authority.sql`;
  - RLS, lifecycle, ledger and payment authority SQL checks;
  - rollback round trip for the authority, lifecycle and ledger migrations;
  - ledger concurrency script: 24 parallel sessions, one start, 23 stale completions rejected;
  - ledger integration tests: 12 pass;
  - application integration tests: 10 pass, each restart in a separate process, including two processes racing to start one payment.
- `npm run build:web`: exit 0.
- Em dash and banned-word scan over the changed files: no matches.

Operational notes:
- The authority fixtures previously used booking and user ids that the RLS seed already commits in the same database. They
  now use their own id range (`...0000000019a1`, `...0000000019b1`, `...0000000019b2`). Each check file must use
  its own ids.
- The authority checks raise an exception on any failure and print no per-check notices, so a clean run is their result.
- The server accepts only the local `postgres` operating-system account over the socket in this environment. The
  server configuration was not changed. The PostgreSQL cluster stopped during the session and was restarted with
  `pg_ctlcluster 16 main start`.

## 11. Not done in this phase

- No live supplier or payment provider was integrated, and no test calls one.
- No real booking, payment, refund or ticket issuance was enabled. Live transactions remain off.
- Capture, release and refund are not wired to the application.
- The `pg` driver was not installed.
- Nothing was committed, pushed, merged or deployed.
- Phase 19.3 was not started.
