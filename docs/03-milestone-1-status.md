# Milestone 1 status

Date: 2026-11-12

## Built and verified

| Area | Files | Verification |
|---|---|---|
| Money (integer minor units, explicit currency, no cross-currency addition) | `packages/core/src/money.ts` | 22 unit tests, all passing (`npm run test:unit`) |
| Booking status (reservation and ticket status kept separate; no "Ticketed" without a supplier ticket) | `packages/core/src/booking-status.ts` | unit tests |
| Time zones (UTC storage, airport-local display) | `packages/core/src/time.ts` | unit tests |
| Flight supplier interface | `packages/flights/src/supplier.ts` | type-only, used by the mock |
| Mock flight supplier (deterministic, includes Lagos departures) | `packages/flights/src/adapters/mock.ts` | unit tests |
| Database schema, RLS, role guard, audit log | `supabase/migrations/20261112000000_initial_schema.sql` | 13 access and constraint checks against PostgreSQL 16 (`npm run test:db`) |

A deliberate mutation check confirmed the database suite fails when the role-change guard is removed.

## Not built yet

- **Next.js application.** Package installs are blocked from this environment (the npm registry is unreachable), so I could not scaffold or build the app. This needs package installs enabled.
- **Supabase Auth in the app.** The database side (profile creation on sign-up, role model) is written and tested. The sign-in pages and session handling need the Next.js app.
- **Search UI and booking flow.** Depends on the app scaffold.
- **Real supplier, payment, and FX adapters.** Blocked on the approvals listed in `01-commercial-dependencies.md`.

## Decisions recorded in the schema

- **Role changes** happen only through the service role (server code) or an admin. Changing a role from the Supabase SQL editor will fail unless it runs with the service role. This is intentional.
- **Audit log** is append-only for every role, enforced by a trigger, not only by permissions.
- **Travel document numbers** (passport numbers) are not stored. Their storage needs encryption, retention, and access rules, and those depend on the data-protection review.
- **Customer writes** to bookings, payments, and tickets are blocked at the database level. Only server code changes them.

## How to run the checks

```
npm run test:unit
PGHOST=<host> PGPORT=<port> PGUSER=postgres npm run test:db
```

`test:db` drops and recreates the database named by `TEST_DB` (default `booking_test`). It refuses to run unless that name contains "test", so it cannot be pointed at a real database by accident.
