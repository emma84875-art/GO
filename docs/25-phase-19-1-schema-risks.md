# 25. Phase 19.1: schema and state-model risks, and decisions taken

Date: 26 November 2026
Authority: `24` (Phase 19.0 decision record, D3 option (c) and the approved sequence).
Scope: unified booking and fulfilment state model, database schema, migration and rollback. No supplier order integration, booking endpoints, workers, ticket verification logic, live supplier calls, payments or customer data.

Status: implemented and verified locally (not committed). See section 6 for the verification record.

## 1. Current state inventory (before changes)

| Area | Vocabulary | Where it lives | Used by code? |
|---|---|---|---|
| Fulfilment | 15 states (`held` to `refunded`) | `packages/fulfilment/src/status.ts` | Yes: orchestrator, portal, support, notify |
| Reservation and ticket | `reservation_status` (7) and `ticket_status` (4) | `packages/core/src/booking-status.ts`, `bookings` table | Only a core unit test. Not wired |
| Payment | 9 states | `packages/payments/src/state.ts`, `payments.status` check | Yes, matches the database |
| Display categories | 9 categories over the fulfilment states | `packages/portal/src/status-category.ts` | Yes |
| Capture gate | `'confirmed' | 'pending' | 'failed' | 'unknown'` | `packages/payments/src/money-safety.ts` | Yes |

Two vocabularies describe the same booking, and neither matches the approved sequence. The fulfilment model has no verification stage and no settlement stage, and it captures on `ticketed` (supplier-reported tickets, before GO verification).

## 2. Conflicts with the Phase 19.0 decision

| # | Conflict | Location | Handling in 19.1 |
|---|---|---|---|
| C1 | GO pays the airline from its own balance (`payOrder` in `payAndRead`) | `orchestrator.ts` | Removed. If the supplier says payment is due, the booking is blocked and nothing is paid. Recorded in code and tests |
| C2 | Capture is allowed on supplier-reported `ticketed`, before GO verification | `orchestrator.ts`, `money-safety.ts` | The capture gate now requires `verified`, a state that only GO verification can set. Verification logic is not built (19.x), so capture is unreachable in code |
| C3 | Confirmation was set at capture, with no check of the partner side | `orchestrator.ts` | `confirmed` now requires `captured`, and `captured` requires `tickets_verified_at`. Partner remittance is a separate record and does not gate confirmation (decision 10). No booking reaches `confirmed` in code yet |
| C4 | Database allows `ticketed` with no verification | `bookings` checks | Replaced by milestone checks and a transition guard |
| C5 | Database currency checks allow four codes only | `bookings`, `payments`, `searches` | Replaced by an ISO 4217 reference table generated from the committed List One metadata |

## 3. Data-loss and schema risks

| # | Risk | Likelihood | Mitigation in 19.1 |
|---|---|---|---|
| R1 | Converting `bookings.reservation_status` and `ticket_status` into one column could mis-map an existing row | Low: the tables are pre-launch, and no code writes bookings yet | The migration aborts unless every existing row maps unambiguously. Only `(draft, not_issued)`, `(quoted, not_issued)`, `(pending_payment, not_issued)` and `(reservation_failed, not_issued)` are accepted. Anything else stops the migration and changes nothing |
| R2 | `payment_confirmed`, `reservation_pending` and `reservation_confirmed` cannot be mapped without guessing. `payment_confirmed` could mean capture before ticketing, which the policy forbids | Medium if any data exists | Not mapped. The migration refuses, and a person must decide each row |
| R3 | Rolling back after new states exist would discard information | Medium | The rollback refuses if any row is in a state with no legacy equivalent. It does not map to a wrong state |
| R4 | Tightening currency checks could reject existing rows | Low | Existing rows use NGN, USD, GBP or EUR, all of which are current ISO codes. The foreign key is added only after the check is confirmed |
| R5 | Payment capture trigger could block the existing RLS fixtures | Certain | The RLS fixtures are updated to create verified tickets before they insert captured payments. The purpose of each test is unchanged |
| R6 | Dropping columns loses data | Certain for the two legacy columns | Values are copied into `booking_status` first, in the same transaction. The rollback restores both columns |
| R7 | Milestone checks could reject future valid writes | Low | Checks are derived from one stage table, mirrored in TypeScript and tested for agreement |
| R8 | Legacy currency codes (ANG, BGN, CUC, HRK, SLL, ZWL) could be used for new bookings | Medium | The reference table records `list_status`. A trigger refuses non-current codes on new writes. Legacy codes stay readable |

## 4. Decisions taken in 19.1 (within the 19.0 authority)

1. **One state vocabulary.** `BookingState` in `packages/core/src/booking-lifecycle.ts` is the only booking and fulfilment vocabulary. The fulfilment module and the database both use it. It has 20 states.
2. **Happy path:** `draft`, `quoted`, `authorised`, `partner_ordered`, `ticketing_pending`, `tickets_issued`, `verified`, `captured`, `confirmed`.
3. **Milestones are recorded separately** as timestamps: `quoted_at`, `authorised_at`, `partner_order_confirmed_at`, `tickets_issued_at`, `tickets_verified_at`, `captured_at`, `confirmed_at`. Each state requires the milestones of every earlier stage. There is no remittance milestone.
4. **Funding is fixed in the schema:** `funding_model` may only be `partner_funded`. A partner order requires a named ticketing partner. No table records a GO payment to a supplier.
5. **Transitions are enforced in the database** by a trigger that uses the same table as the TypeScript module. A test compares the two. The table has 55 permitted pairs.
6. **Capture requires verification in the database:** a payment cannot become `captured` unless its booking is `verified` and every passenger has a verified ticket. A booking cannot become `captured` without a captured payment.
7. **Confirmation requires verification and capture, and nothing else.** A booking can move to `confirmed` only from `captured`, only when every passenger's tickets are verified and a payment is captured. The database trigger checks this. `CONFIRMATION_PREREQUISITES` is exactly `tickets_verified_at` and `captured_at`.
8. **Three money flows are kept apart** (docs/24, section 3A):
   - *Customer capture*: `payments.status = captured`. Gates confirmation.
   - *Provider settlement*: `payments.provider_settled_at`, set only on a captured, refund-pending or refunded payment. Reconciled separately. Never gates a booking.
   - *Partner remittance*: a separate `partner_remittances` record. Never gates a booking.
9. **Partner remittance is tracked on its own record, not in the booking state.** `partner_remittances` has one row per booking (a unique `booking_id`), created only for a booking that has a partner order. Its statuses are `not_required`, `pending`, `paid`, `failed` and `under_review`. Its transitions are enforced by a trigger: `pending` to `paid`, `failed` or `under_review`; `failed` to `pending` or `under_review`; `under_review` to `pending`, `paid` or `failed`. `paid` and `not_required` are final.
13. **Administrator-only actions.** Only an administrator with MFA (`is_admin_mfa()`) may record or change a remittance to `paid`, record one as `not_required`, or correct its agreement terms. Support and operations staff with MFA may create a pending remittance, move it to failed or under review, and retry it. Customers cannot see or change remittances. The rule is in the database trigger and in `remittanceChangeProblems` (`packages/core/src/partner-remittance.ts`).
14. **Agreement terms come from the agreement, not from a default.** Every record cites the agreement reference and the clause that sets the amount, currency and due date. The database has no default for `amount_minor`, `currency` or `due_at`, and no deadline is hardcoded. A correction to any agreement field is an administrator action with a reason, and the old and new values are both recorded.
15. **Not required needs approved, written evidence.** A `not_required` record needs the agreement reference and clause, the approval by the signed-in administrator (`no_obligation_approved_by` must equal the signed-in user), the approval time, and written evidence of at least 20 characters. It carries no amount, currency or due date. Its evidence cannot change once recorded.
16. **Audit trail and recovery.** Every creation and change of a remittance writes an append-only row to `partner_remittance_events`, with the actor, the state before and after, and the reason. Nothing can update or delete these rows. Recovery from `failed` or `under_review` is a counted attempt: `attempt_count` goes up by one each time the record is retried, and the retry needs a note on what was corrected. The counter is set by the trigger, not by the caller.
10. **Remittance cannot change a booking.** No remittance status is a booking state, and no trigger reads a remittance to decide a booking transition. The one shared word, `failed`, is a known overlap. It is safe because the two values live in different columns, and the code must read `partner_remittances.status` for remittance.
11. **Customer ticket visibility is stricter.** A ticket is shown only when GO has set `tickets.verified_at` and the booking is in `verified`, `captured` or `confirmed`. The database policy `tickets_select` applies the same rule to customer reads. Before verification the customer sees "Tickets pending verification" with no valid ticket.
12. **Zero-capital rule preserved.** GO never funds supplier ticket issuance. Partner remittance is a payment obligation under the partner agreement and is never described as GO financing ticket issuance. No code path pays a supplier from GO funds.

## 5. Not decided and not built in 19.1

- The partner remittance terms themselves: which agreements require a remittance, and the amounts and due dates in each. Remittance records are created only from a named agreement. Nothing creates them automatically, and no amount is ever inferred.
- Whether an agreement allows a remittance to fall due before ticket issuance or after confirmation. The record supports any date the agreement gives. No general rule is built.
- Who approves a `not_required` record beyond the signed-in administrator, and whether a second person must confirm it. Not built.
- The remittance payment process itself: how GO sends the money and records the reference. The record holds the reference; it does not move money.
- Ticket verification rules against names, itinerary and the partner reference (19.x). The database only checks that a verified timestamp exists.
- How `review_required` is resolved by a person, and by whom.
- Decimal exponents for each currency are checked by the application through the committed metadata. The database checks only that the code is a current ISO 4217 code.

## 5B. Limitation: one remittance record per booking

The model holds one remittance record for each booking (a unique `booking_id`). It does not support:

- **Instalments**, where an agreement splits one booking's amount into several payments with separate due dates.
- **Several invoices** under one booking, each with its own amount and due date.
- **Partial remittance** against a single amount, with several payment references.

If a partner agreement needs any of these, the model must be extended before that agreement is used for a live booking. The extension is a child table of remittance lines, each with its own amount, due date, status and reference, and a rule that the lines sum to the agreed total. Until then, a booking under such an agreement cannot have a correct remittance record, and it must not be booked live. The database cannot detect this on its own, so the check must be made when the agreement is approved.

## 5A. Remaining risks

| # | Risk | Mitigation or owner action |
|---|---|---|
| K1 | A booking can be confirmed while its partner remittance is unpaid, failed or under review. GO could then owe the partner money with no booking consequence. | Accepted consequence of the owner's decision. Reconciliation must watch failed and under-review remittances. An overdue or failed alert is needed before any live booking (19.x). |
| K2 | The word `failed` is both a booking state and a remittance status. | Separate columns, and a test that pins the overlap. Operations code must read `partner_remittances.status` for remittance. |
| K3 | An administrator can mark a remittance `paid` or `not_required` alone. A single administrator is a single point of failure for those decisions. | Administrator-only is now enforced. A second approver for `not_required` is not built (section 5). |
| K4 | A `not_required` record can still be wrong if the agreement is misread. The evidence is written, but nothing checks it against the agreement text. | The evidence and clause are kept in the audit trail. A periodic review of `not_required` records against the agreements is a process requirement. |
| K5 | The stricter ticket visibility rule means customers see no valid ticket until GO's verification. Verification is not yet built, so no customer can receive a ticket in code. | Expected. Verification is the 19.x work. |
| K6 | Agreement terms could be corrected after a payment reference exists. | A correction needs an administrator and a reason, and each change is in the audit trail. A `paid` remittance cannot change at all. |
| K7 | A retry after a failed remittance uses the same amount and reference. If the partner rejected it for a reason that is not corrected, the retry fails again. | Each retry is counted (`attempt_count`) and needs a note on what was corrected. Repeated failures should go to `under_review` and an administrator. A limit on attempts is not built. |
| K8 | The database trusts a signed-in administrator's MFA claim (`aal2`). A compromised administrator account can mark remittances paid, or capture a payment. | Standard account controls apply. The audit trail records every change for review. |
| K9 | The one-record-per-booking limit cannot represent instalments or several invoices (section 5B). | Check agreement structure before approval. Do not book live under such an agreement until the model is extended. |
| K10 | Any finance user with MFA can act on any remittance across all bookings (owner decision: finance is trusted across bookings). A compromised finance account can fail or retry remittances, and change the record's status to `under_review`. It cannot mark paid or correct terms. | Every change is in the audit trail with its actor. Assignment limits are not built (owner decision). Review finance activity regularly. |
| K11 | Resolved in section 9. No signed-in role can change a payment; the only paths are the backend capture request and the verified provider event, and every transition is checked. | See section 9. |
| K12 | The verification of provider signatures happens in the backend, before the database is called. The database records the verification claim (`webhook_signature` or `provider_lookup`) and trusts the service role to have checked it. | Section 9. The live webhook endpoint (19.x) must verify the signature and must not call the function on any other basis. |
| K13 | The web app's staff routing has no finance screen, so a finance user sees the customer interface. Remittance work has no interface until one is built. | Expected for 19.1, which builds the database controls only. The finance screen is a 19.x item and must reuse the database rules. |

## 6. Verification record (26 November 2026)

- Unit suite: 932 of 932 passing (after the provider event controls).
- Lifecycle file (`packages/core/test/booking-lifecycle.test.ts`): 40 tests. Remittance rules (`packages/core/test/partner-remittance.test.ts`): 26 tests, including finance, support, operations, customer and administrator cases. Auth matrix (`packages/auth/test/access-control.test.ts`): finance holds `remittance.manage` only. They cover the 20-state vocabulary, the 55 transitions, confirmation with remittance pending and not required, the remittance statuses and transitions, the ticket visibility list, and agreement between the TypeScript tables and the migration.
- Database checks (`scripts/test-db.sh`): all migrations applied in order, RLS and constraint checks passing (one existing expectation updated: an unknown role value is now `root`, since `finance` is a valid role), and lifecycle checks A to P and N passing (`supabase/tests/booking_lifecycle.sql`). Remittance and finance checks:
  - K: finance staff create and fail a remittance and retry it with a note (the retry count rises); support staff are refused by the trigger; finance cannot mark paid, record not required or correct terms; an administrator corrects terms with a reason, and the change is audited; paid needs a reference and is final; not required needs administrator approval by the signed-in user, evidence of at least 20 characters, and no amount; the evidence cannot change; a remittance cannot be created as paid, without an amount, or without a partner order; a service-role change is refused; the audit trail is append-only.
  - L: finance and administrators can read and act on remittances; support, operations, customers and unauthenticated users see no rows and cannot write (inserts are refused).
  - P: capture is requested only by the backend after every ticket is verified; a provider result confirms it; no signed-in user (finance included) can change a payment, and the service role cannot change one directly; each action is recorded with its actor.
  - Q: valid events apply once; invalid, replayed, duplicate, stale, illegal and mismatched events change nothing and are recorded with their results.
  - N: definer search paths, anon and authenticated execute rights, table privileges, audit immutability, attribution immutability, administrator identity (role and MFA, administrators only for paid), and session-function shadowing (N1 to N9; see section 6B).
- Rollback round trip: passes on an empty database. It restores the legacy columns, re-applies 19.1 and re-runs the lifecycle checks.
- Rollback refusal: checked by hand on a partner-ordered booking. It stops with "Rollback stopped: 1 booking(s) are in a state the legacy model cannot represent. Nothing was changed." The booking column remains.
- Production web build: 23 files, no problems.
- Generated migration: `node scripts/generate-booking-lifecycle-sql.mjs --check` passes.

## 6B. Security review of SECURITY DEFINER functions (26 November 2026)

Scope: every `SECURITY DEFINER` function in `public`, including those added or changed by 19.1. Evidence: `supabase/tests/booking_lifecycle.sql`, block N (checks N1 to N9), run against a freshly built database.

| Check | Result | Evidence |
|---|---|---|
| 1. Each definer function pins its `search_path`, with `pg_temp` last | Fixed. Ten earlier-phase functions had `search_path=public` only. All are now `public, pg_temp`, set by a loop in the migration (section 6a). | N1 |
| 2. Unqualified names inside definer functions | Our functions qualify every table and helper with `public.` or `auth.`. Built-ins (`now`, `btrim`, `to_jsonb`, `gen_random_uuid`, `json_build_object`) come from `pg_catalog`. A session-level function of the same name did not change the administrator check (probe, and N9). | N9 |
| 3. Untrusted roles cannot execute privileged functions | No definer function is executable by `anon`. The trigger and helper functions are not executable by `authenticated` or `PUBLIC`. Only the intended predicates (`is_staff_mfa`, `is_admin_mfa`, `current_app_role`) and the staff procedures are executable by `authenticated`, and each checks its own role and MFA. `booking_stage` stays executable by `authenticated` because the milestone CHECK constraint runs as the writing user. It is pure. | N2, N3 |
| 4. Trigger functions cannot bypass checks or touch unrelated records | Each trigger changes only the row it guards. The audit trigger writes only to `partner_remittance_events`. Attribution (`id`, `created_at`, `agreement_recorded_by`, `agreement_recorded_at`) is now immutable after creation (fixed; a gap found by N6). Administrator checks are inside the trigger, not in the caller. | N6, N7, N8 |
| 5. Administrator identity, role and MFA are validated | `is_admin_mfa()` needs the `admin` role from the profile for `auth.uid()` and an `aal2` session. Support staff, customers, and an administrator without MFA are each refused. A recorded agreement must name the signed-in user, and a `not_required` approval must name the signed-in administrator. Service-role code (no `auth.uid()`) cannot mark a remittance paid or not required. | N7, N8 and K9 |
| 6. Audit records cannot be altered or deleted | `partner_remittance_events` has no UPDATE, DELETE or INSERT privilege for `authenticated`. The append-only trigger blocks update and delete for every role, and a new statement trigger blocks truncate. Only the audit trigger inserts. | N5 |

Findings and fixes in this review:

- **Search path.** Ten earlier-phase definer functions in `public` did not name `pg_temp`. Fixed in the migration for all definer functions.
- **Table privileges.** `anon` and `authenticated` held `TRUNCATE`, `TRIGGER` and `REFERENCES` on the booking tables. Truncate bypasses row level security. Revoked. Ordinary DML stays limited by policy.
- **Attribution.** `agreement_recorded_by` and `agreement_recorded_at` could be rewritten after creation. Now immutable.
- **Audit trail.** Could be truncated. Now blocked by a statement trigger.

Limits of this review:

- The test shim grants the `authenticated` role the same default privileges as a Supabase project. Whether a real project's default grants differ is not confirmed. The migration revokes what the shim granted. A later migration that creates tables must revoke the same privileges, because the shim's default privileges would grant them again.
- Audit `actor` is the signed-in user. Changes made with the service role or by the table owner record a null actor. The only service-role path that changes remittances is one that cannot mark them paid or not required.
- Any staff member with MFA (support, operations or administrator) may create, fail and retry a remittance for any booking. Passenger data is limited to assigned bookings, but remittance records are not. Scoping remittances to assignments or to finance roles is not built.
- The rollback does not restore the earlier, looser search paths. A search path that names `pg_temp` is stricter and does not break the restored legacy code. The rollback does not restore `TRUNCATE`, `TRIGGER` or `REFERENCES` for the API roles. Those were never needed.

## 7. Implementation notes

- The orchestrator (`packages/fulfilment/src/orchestrator.ts`) no longer pays suppliers. `readOrder` blocks the booking when a supplier asks GO to pay. `captureIfVerified` captures only from `verified`. `confirmed` is not set by any code path yet.
- The fixture supplier is partner-funded by default. The `supplierDemandsGoPayment` knob reproduces the refused demand.
- Customer tickets are shown only from `verified` onwards, in the application and in the database policy. Before verification the customer sees "Tickets pending verification".
- The fulfilment vocabulary is the single shared one. Consumers keep their existing imports through `packages/fulfilment/src/status.ts`, which re-exports the core model.
- The retired reservation and ticket module (`packages/core/src/booking-status.ts`) is removed.
- The RLS fixtures that inserted `captured` payments without a verified booking now test that state in `booking_lifecycle.sql`, where the gate itself is exercised.
- `scripts/generate-booking-lifecycle-sql.mjs` generates the visibility list, the remittance statuses, the transition tables and the administrator-only list from TypeScript, so the database cannot drift from the code.
- The booking and remittance guard functions are `security definer`. Reason: the guards run as the signed-in role and call the `auth` schema and helper functions that role is not granted. A probe with the functions as `security invoker` and the administrator change run as the `authenticated` role was refused with "permission denied for schema auth" (rolled back, nothing changed). The test shim does not grant that schema to the role, so whether a real Supabase project needs the same fix is not confirmed. The definer form is safe either way and is what the test now exercises.
- The service rules for remittance (`packages/core/src/partner-remittance.ts`) mirror the database trigger. Tests compare the administrator-only list and the insert list between the two.

## 8. Finance role, actor rules and payment controls (26 November 2026)

Owner instruction: a dedicated finance role for remittance operations. Finance is trusted across bookings, so no booking-assignment restriction is built.

| Action | Customer | Support | Operations | Finance (MFA) | Administrator (MFA) |
|---|---|---|---|---|---|
| Read partner remittances and their audit trail | No | No | No | Yes | Yes |
| Create a pending remittance from the agreement | No | No | No | Yes | Yes |
| Mark failed, under review, or retry (with a reason or note) | No | No | No | Yes | Yes |
| Mark a remittance paid | No | No | No | No | Yes (with a payment reference) |
| Record not required (with approved evidence) | No | No | No | No | Yes |
| Correct agreement terms (amount, currency, due date, reference, clause) | No | No | No | No | Yes (with a reason) |
| Change a payment's status, captured amount or provider settlement | No | No | No | No (no write path) | No (no write path) |
| Read payment financial events and provider event records | No | No | No | Yes | Yes |

Rules, enforced in the database (`guard_partner_remittance`, `guard_payment_financial`) and mirrored in TypeScript (`packages/core/src/partner-remittance.ts`, `packages/auth/src/access.ts`):

- Finance is a staff role. Its MFA must be verified before the role is granted (`require_verified_mfa_for_staff`), and each action needs an `aal2` session (`is_finance_mfa`, which accepts finance and administrators).
- Finance is not in `is_staff_mfa`. It has no passenger, ticket or booking-read access, and holds only `remittance.manage` in the application matrix.
- Every remittance and payment financial change needs a signed-in user. A change with no authenticated actor, including from the service role, is refused.
- `agreement_recorded_by` and `no_obligation_approved_by` must equal the signed-in user at creation. The recording user, recording time, identifier and creation time cannot change afterwards.
- Each payment financial event (`payment_financial_events`) and remittance event (`partner_remittance_events`) is append-only, cannot be truncated, and carries its actor. Neither table can be written directly by a signed-in role.
- Payment capture: the `captured_minor` column is writable by finance only, must not exceed the amount, and cannot change after capture. Provider settlement is recorded once.
- Customers and staff without the finance role cannot read remittances or the payment audit trail.
- Profile role changes, staff MFA resets and the role lists now include `finance` (super administrators reset finance MFA through the same logged path).

Limits of this section, recorded as risks in section 5A (K10, K13): finance may fail and retry any remittance across all bookings; and there is no finance interface yet. Payment control limits are in section 9.

Rollback: the rollback drops the finance objects and restores the phase 14 and 15 role lists. It refuses while any finance profile, finance MFA reset, remittance or payment financial event exists. The hardened `search_path` on existing functions is kept, because it changes no behaviour.

## 9. Payment controls: provider events and capture (26 to 28 November 2026)

Owner instruction: payment provider webhooks work server to server, without a signed-in finance user; a database status change is never proof of payment; capture is a request confirmed by the provider; and no finance role may mark a payment captured.

Payment states. `capture_requested` is added to the payment states (`PAYMENT_TRANSITIONS` in `packages/payments/src/state.ts`, generated into the database check and transition function). `captured` is reachable only from `capture_requested`. A declined capture returns the payment to `authorised`. A person in review must move it back to `authorised` before a new capture request.

Who can change a payment. Nobody signed in, in any role. The `authenticated` and `anon` roles have no insert, update or delete on `payments`, and no policy grants one. Finance keeps read access (amounts and references, never passenger details). The service role is the backend, and it can change a payment only through two functions. A trigger (`guard_payment_state`) refuses every other financial change, including direct service-role updates, unless one of the two functions has set its authority for the transaction.

Step 1, capture request (`request_payment_capture`, service role only). It records that the backend asked for capture. It refuses unless the booking is `verified` and every passenger's ticket is verified, and unless the payment is `authorised`. It writes a `capture_requested` record with the named backend workflow as actor. It does not record that money moved.

Step 2, provider result (`apply_payment_provider_event`, service role only). It accepts a result only when the caller states how it was verified: `webhook_signature` (the backend checked the provider's signature) or `provider_lookup` (the backend read the provider's own status). Every attempt is recorded in `payment_provider_events` with the provider event ID, provider reference, provider state, amount, currency, occurred time, receipt time, verification, payload digest, processing result, reason and actor (`provider:<name>`). Outcomes:
- `applied`: a legal transition, or a recorded settlement.
- `no_change`: the provider reports pending, or the payment is already in that state.
- `duplicate`: the same provider event ID was already processed. Nothing changes.
- `rejected`: unverified, malformed digest, unknown payment reference, stale (older than the last processed event), unknown state, invalid transition, or a settlement that is not allowed. Nothing changes.
- `review_required`: an amount or currency mismatch, a capture the provider reports without a capture request, or an unexpected state. The payment moves to `review_required` only if that transition is legal.

Idempotency is enforced by a partial unique index: one processed row per provider event ID. Replays are refused as duplicates even when the body differs. A concurrent second copy fails at the index and rolls back, so the backend must treat that error as a retry, not as success.

Capture confirmation. Capture happens only when the booking's tickets are all verified (step 1) and the provider confirms it (step 2). `captured` requires the provider's `captured` result for the same amount and currency, and the existing booking gate still applies. A browser redirect, a client-submitted status and a database edit are never inputs.

Actors. Every change is recorded in `payment_financial_events` with `actor_kind` `backend_workflow` (for a capture request) or `provider_event` (for a provider result), a label, and the provider event row. No row can name a human user. Both audit tables are append-only and cannot be truncated.

TypeScript. The same rules are in `packages/payments`: `webhook.ts` deduplicates on the provider event ID and checks every transition; `payment-flow.ts` requests capture and confirms it only from the provider's status (`confirmCapture`). Adapters parse the provider event ID (fixture `id`, Paystack and Flutterwave `data.id`). Only the `fulfilment` workflow holds `payment.capture` (`packages/auth`); no human role does.

Remaining limitations (recorded as risks):
- K14. Neither real provider reports capture as supported (`capture: 'unconfirmed'` in both adapters). Under the current rule, capture cannot be confirmed with them, so no live capture can happen until a provider's capture is confirmed. Paystack captures on payment, so a Paystack `captured` result from a payment GO has not requested is treated as `review_required`. Its use in a live flow conflicts with the approved rule that capture happens only after ticket verification, Decided by the owner on 28 November 2026: Paystack is excluded from the booking payment flow by name (`BOOKING_PAYMENT_PROVIDERS` in `packages/payments/src/payment-flow.ts`, checked before the capability gate). The capture rule is unchanged and the architecture stays provider-independent. A provider may be added to that list only after its capture is confirmed under the approved rule.
- K15. The database trusts the service role's claim about signature verification. The signature check is implemented in TypeScript (adapters) and is not repeated in SQL, because the secret cannot be read by the database.
- K16. The fixture provider is not a provider. Its tests show the rules, not a provider's behaviour.
- K17. The live webhook endpoint, the provider integration and the finance screen are not built (19.x). The TypeScript payment flow is not yet connected to these database functions; the two must be kept in step when that wiring is built, and the parity of the transition table is checked by the generator.
- K18. Refund results are not mapped. A provider report of `refunded` is rejected as an unknown state, so refunds need their own workflow and rules before any live refund (19.x).

