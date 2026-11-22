# 15. Customer booking management and operations portal (Phase 11)

Date: 13 Nov 2026
Status: domain and access layer built and tested. No UI, no authentication wiring, no production build, no live service, no paid email. Awaiting owner approval. Nothing committed.

## What was built

New package `packages/portal` (no new dependencies). It reuses the existing fulfilment status rules, customer and privacy views, hold expiry, payment statuses and the audit shape. It does not change any existing module.

| File | Purpose |
|---|---|
| `src/model.ts` | `PortalBooking`: owner ID supplied by the caller, fulfilment record, history |
| `src/access.ts` | Roles (customer, support, admin), owner checks, staff-only operations guard |
| `src/status-category.ts` | Exhaustive mapping of every fulfilment status to one display category |
| `src/timeline.ts` | Timelines. Times are never invented; missing times are null and listed first |
| `src/customer-dashboard.ts` | Customer's own bookings split into upcoming and past, with itinerary, passengers, tickets, refund rule and cancellation decision |
| `src/requests.ts` | Cancellation and support requests. Recorded for staff; no supplier action |
| `src/ops-dashboard.ts` | Staff search, hold watch, attention list, investigation view |
| `src/notifications.ts` | Message builders, adapter boundary, unconfigured email adapter, recording adapter, delivery outbox |
| `test/portal.test.ts` | 40 tests |

`package.json` `test:unit` now includes the portal tests.

## Status wording

- "Confirmed" is shown only for fulfilment status `confirmed` (supplier tickets and captured payment).
- `ticketed` is shown as "Tickets issued", never as confirmed.
- `order_unknown`, `ticketing_unknown` and `partially_fulfilled` are shown as "Needs checking".
- `expired` is grouped with `failed` as "Not completed".
- Refund rules show "not confirmed" when the supplier did not say, never "no".

## Access rules

- A customer sees only bookings they own. Another customer's booking is reported as not found.
- Operations functions refuse customer actors.
- Staff see passenger date of birth and nationality (matches `privacy.ts` support view). Ticket numbers are masked to the last four digits.
- Customer views never include internal reasons (`lockedReason`, `blockedReason`).

## Notifications

- Ticket-issued email is generated only when the supplier has issued documents and the status is ticketed or confirmed. Email never contains ticket numbers, passenger names or payment details.
- The default adapter sends nothing and reports `not_configured`.
- A message is marked sent only when the adapter reports sent. Thrown errors are stored as `provider_error`, without the error text (it can contain addresses).
- A sent message is never sent again. A failed message can be retried and does not change the booking.

## Test results

- Unit tests: 228 pass (188 existing, 40 new).
- Database checks: all 13 RLS and constraint checks pass on a disposable local PostgreSQL 16 cluster (`scripts/test-db.sh`), run against the existing migration and policies, unchanged.
- Type check: the portal source files pass `tsc --strict`. The test file is checked only by running it, because `@types/node` is not installed.

## Security concerns

1. **Two copies of the access rules.** The TypeScript checks mirror the SQL policies. They can drift. The database policies are the enforcement layer. Persistence is not wired, so the portal currently runs on in-memory stores.
2. **Database reads must use the caller's session.** When the portal reads from Postgres, customer reads must use the user's own JWT so RLS applies. A service-role read would bypass RLS.
3. **Existing leak in `fulfilment/src/customer-view.ts`.** `customerScreen` returns `lockedMessage`, which carries internal text. The portal does not use it, but any screen built on `customerScreen` directly would show it. Recommend removing it from the customer screen. Not changed in this phase.
4. **Staff views are not audit logged.** Viewing passenger detail, searching by surname and opening investigations should each write an audit entry. Not built.
5. **Surname search enables enumeration by staff.** It is limited to 50 results and needs a criterion. Rate limiting and search logging are not built.
6. **No `finance` role in the database.** `privacy.ts` defines a finance view, but `profiles.role` allows only customer, support and admin.
7. **Requests and notifications are not persisted.** Cancellation and support requests, and the audit drafts, are returned to the caller. No table exists yet. A decision on schema is needed first.
8. **Email addresses are not resolved.** The adapter must look up addresses on the server from the user ID. This is not built, and no provider is approved.

## Remaining blockers

- **UI and production build.** Blocked by package installs. There is no Next.js scaffold, no pages, no screenshots and no production build. This is a restriction, not a cost.
- **Authentication.** No Supabase Auth or sign-in flow is wired. Customer identity is supplied by the caller.
- **Database read paths and request tables.** Need a schema decision, then a migration, then an RLS test for each new table.
- **Documents.** No document store and no PDF generation. Ticket numbers are shown on the dashboard; downloadable ticket files are not available.
- **Email provider.** None approved. Needs owner approval because most providers are paid.
- **Supplier-side actions.** Cancellation with the supplier stays in the orchestrator behind the production gate. Staff cannot trigger it from this phase.

## Decisions for the owner

- [ ] Approve the portal domain layer and the test results above.
- [ ] Approve the next phase: persistence and RLS tests for requests, audit entries and staff access logging.
- [ ] Decide whether to remove `lockedMessage` from `customerScreen` (recommended).
- [ ] Decide when the UI can start, given the package-install restriction.
- [ ] Approve or refuse any email provider. None is approved.
