# 16. Customer support, cancellation and refund management (Phase 12)

Date: 15 Nov 2026
Status: domain, permissions, audit and workflows built and tested. Cancellation execution, supplier refunds, payment-provider refunds and GO refunds are all disabled. No UI, no persistence, no email provider, no production build. Nothing committed. Awaiting owner approval.

## What was built

New package `packages/support` (no new dependencies). It reuses the portal's access roles, message type and outbox, the fulfilment status rules and the payment states. Existing modules were not changed, except one type annotation (see below).

| File | Purpose |
|---|---|
| `src/permissions.ts` | Permission per role. Refund approval and execution are admin-only |
| `src/audit.ts` | Append-only, numbered, frozen audit entries. Detail holds codes only |
| `src/support-requests.ts` | Categories, priorities, statuses, transition table, duplicate-safe defaults |
| `src/cancellation.ts` | Cancellation options built from booking status, verified airline state and fare rules |
| `src/refunds.ts` | Refund sources (supplier, payment provider, GO), amount limits, eligibility rules, customer wording, refund transitions |
| `src/notifications.ts` | Email messages for requests, staff replies and refund updates. No message text, ticket numbers or unconfirmed amounts |
| `src/service.ts` | The only place that changes state. Checks permission, ownership, input and gates, then audits |
| `test/support.test.ts` | 61 tests |

`package.json` `test:unit` includes the support tests.

## Permissions

| Permission | Customer | Support | Admin |
|---|---|---|---|
| Create request, reply on own request, read own requests | yes | no | no |
| Read all requests, reply to requests, internal notes, triage, assign | no | yes | yes |
| Request cancellation (own booking) | yes | no | no |
| Review cancellation options (any booking) | no | yes | yes |
| Execute cancellation (gated) | no | no | yes |
| Request refund (own booking) | yes | no | no |
| Check refund eligibility | no | yes | yes |
| Approve or reject refund | no | no | yes |
| Execute refund (gated) | no | no | yes |
| Read audit log | no | no | yes |

A refund cannot be decided by the person who requested it, even by an admin account (defence in depth; the requester is always a customer in practice).

Every denial is audited and then thrown as `AccessDeniedError`. A customer asking about another customer's booking or request gets "not found", not "forbidden".

## Gates (all off by default)

- **Cancellation execution:** `cancellationExecutionEnabled: false`. With the gate off, the airline is never called, and the request is marked `blocked` with the reason. Tested: the airline call count stays at zero.
- **Refund execution:** `REFUNDS_DISABLED` is `supplier: false, payment_provider: false, go: false`. With a source's gate off, no executor is called and the refund stays `approved`. Tested.
- **Existing `cancelBooking` in fulfilment is not called** by this package.

## Refund rules

- **Amounts:** must be a positive whole number, and at most the booking total at request time. Over-limit amounts at eligibility time are recorded as ineligible with the reason, and the refund is rejected.
- **Supplier refund:** eligible only if the airline has confirmed it. Otherwise "unconfirmed".
- **Payment-provider refund:** eligible only if the payment is captured, the amount is still refundable, and the provider's refund capability is `supported`. Both Paystack and Flutterwave are `unconfirmed` today, so every payment-provider refund stays unconfirmed.
- **GO refund:** limited to the GO fee. The fee policy is zero, so no GO refund can be made today.
- **Approval:** requires eligibility `eligible`. An unconfirmed refund cannot be approved.
- **Duplicates:** one open refund per booking. A second request is refused.
- **Wording:** no customer message says a refund is promised. The confirmed amount is shown only once the refund is completed.

## Request and refund state machines

- Requests: open, assigned, awaiting_customer, resolved, closed. Closed cannot move. A customer reply reopens an awaiting or resolved request.
- Refunds: requested, pending_approval, approved, rejected, execution_pending, completed, failed. Completed and rejected are terminal. Failed can be retried through execution.

## Test results

- Unit tests: 289 pass (228 before, 61 new). Covers permissions, ownership, duplicate requests, invalid amounts, failed operations, transitions, gates, customer wording, notification failure handling, and audit contents.
- Strict type check of the new package: passes.
- Type check of all package sources: no real errors remain. Remaining messages are missing Node type definitions in this environment (`node:crypto`, `Buffer`, `fetch`), which affect several existing files.
- Database RLS suite: not re-run, because Phase 12 adds no migration and no database code.

## Change to an existing file

- `packages/payments/src/adapters/flutterwave.ts`: `initiate` is now annotated `Promise<never>`. It always threw before, so this is a type-only correction for an error the strict check reported. No behaviour changed.

## Production build

Not run. Blocked: package installs are disabled (`npm view next` fails with ENOTFOUND), there is no framework scaffold, and there is no UI. The strict type check above is the closest available check.

## Security concerns

1. **The existing `cancelBooking` has no owner gate.** It calls the supplier's cancel and the payment refund directly. The `productionEnabled` check exists only in `placeOrder`. A future caller could cancel with the airline without the gate. Recommend adding the same gate here, before any cancellation is enabled. Not changed in this phase.
2. **`payments.refund()` has no owner gate.** It relies on the provider's refund capability alone. Safe today because both providers are `unconfirmed`. The owner gate should be added before any provider refund is enabled.
3. **Existing leak in `customerScreen` (Phase 11).** It returns `lockedMessage`, which carries internal text. Still open.
4. **Audit log is in memory.** It must be persisted append-only, with database permissions that stop updates and deletes.
5. **Staff reads of refunds and requests are audited for denials only.** Allowed reads are not logged, so passenger-detail access is not yet traceable. Add read logging before staff use.
6. **Eligibility is entered by staff from facts the caller supplies.** The facts function must read the real supplier and payment records, not caller-provided values. The service trusts the `RefundFacts` it is given.
7. **Email content is kept generic.** Email says only that something has changed. Sign-in is required to see detail.

## Remaining blockers

- Package installs and the production build (see above).
- Persistence for requests, refunds, cancellations and the audit log, with RLS for each table.
- A supplier order lookup for cancellation. Duffel's order operations are not implemented, so the airline state is always "unavailable" today, and cancellation offers support only.
- Supplier refund confirmation. No supplier refund route is verified.
- Payment-provider refunds are unconfirmed for both Paystack and Flutterwave.
- A UI for the customer support centre and the internal dashboard.
- An email provider. None is approved.

## Decisions for the owner

- [ ] Approve the Phase 12 workflows and the gates staying off.
- [ ] Approve adding the owner gate to `cancelBooking` and to `payments.refund()` (recommended, before any execution is enabled).
- [ ] Approve the persistence and RLS design for requests, refunds and the audit log.
- [ ] Decide the refund approval policy: which amounts need a second admin, if any.
- [ ] Confirm the GO fee policy. Currently zero, so GO refunds are impossible.
