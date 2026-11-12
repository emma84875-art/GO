# Architecture (proposed)

Status: proposal for approval. No code has been written yet. See `01-commercial-dependencies.md` for what is blocked on external approvals.

## Principles

- Next.js and TypeScript only. No second framework.
- Every external provider (flight supply, payments, auth, crypto) sits behind an interface. Booking logic never imports a provider SDK directly.
- Sandbox and production are separate configurations. Production adapters refuse to load unless their provider is marked approved in config.
- A booking is never shown as a confirmed ticket until the supplier returns ticket numbers.

## Repository layout

```
apps/
  web/                 Next.js App Router, TypeScript, Tailwind
    app/               public site, search, booking flow, account, admin
    server/            server-only code: route handlers, server actions
packages/
  core/                domain types, money and currency, booking state machine
  flights/             FlightSupplier interface
    adapters/
      mock/            deterministic fake supplier (default, dev and tests)
      duffel/          added only after Duffel is confirmed (sandbox first)
  payments/            PaymentProvider interface
    adapters/
      mock/            dev and tests
      paystack/        disabled until approved
      flutterwave/     disabled until approved
      stripe/          disabled until approved
  auth/                Supabase Auth helpers, role checks
supabase/
  migrations/          SQL migrations, version controlled
  seed/                sandbox data only
docs/
```

## Environments

| Setting | Development | Sandbox | Production |
|---|---|---|---|
| Flight supplier | mock | provider sandbox | provider live (approved only) |
| Payments | mock | provider test keys | provider live (approved only) |
| Supabase | local | separate project | separate project |
| Data | synthetic | synthetic | real customers |

Config rules:
- Each provider adapter reads `PROVIDER_MODE` (`mock`, `sandbox`, `production`).
- `production` requires the provider name to appear in `APPROVED_PROVIDERS`, which is set only by the release process. If it is missing, startup fails.
- Secrets are read server-side only, never exposed to the browser, and never committed. `.env*` files are gitignored.

## Booking status model

Reservation status and ticket status are separate fields. The UI must never merge them.

**Reservation status**
`draft` → `quoted` → `pending_payment` → `payment_confirmed` → `reservation_pending` → `reservation_confirmed` | `reservation_failed`

**Ticket status**
`not_issued` → `ticketing_pending` → `ticketed` | `ticketing_failed`

Rules:
- `ticketed` is set only when the supplier returns ticket numbers for every passenger segment. Nothing else sets it.
- A paid booking whose ticketing has not completed shows as "Payment received, ticketing in progress". It must never show "Ticketed" or "Confirmed ticket".
- Failed ticketing triggers a refund flow, not a silent retry loop, and every transition is written to the audit log.

## Data model (initial)

- `profiles`: one row per auth user, role (`customer`, `support`, `admin`), country, phone.
- `passengers`: name as on passport, date of birth, nationality, document number (encrypted or held by the supplier, see security), linked to a booking.
- `searches`: origin, destination, dates, cabin, passengers, requested currency, created by, timestamp.
- `offers`: supplier offer ID, search link, price, currency, expiry, fare rules snapshot.
- `bookings`: owner, offer snapshot, reservation status, ticket status, supplier order ID, total in display currency, total in settlement currency, FX rate snapshot and timestamp.
- `booking_segments`: origin and destination airports, departure and arrival in local time with UTC offset, carrier, flight number. Supports international departures from Nigeria, including routings through hubs outside Nigeria.
- `payments`: booking, provider, provider reference, amount, currency, status, webhook event IDs seen (for idempotency).
- `tickets`: booking, passenger, ticket number, issued at, supplier reference.
- `audit_log`: actor, action, entity, before and after (no card or passport data), timestamp.

Money is stored as integer minor units with an explicit currency code. Never floats.

## International departures from day one

- Display currency defaults to NGN for Nigerian customers. Supplier prices are in their own currency. We store both and the FX rate used.
- Airport and time handling uses IANA time zones per airport, so a Lagos departure and a London arrival are both correct.
- Passport and nationality fields follow the supplier's requirements, which differ by destination. Validation rules are data-driven, not hard-coded to Nigeria.
- Pricing shows taxes and fees per jurisdiction. Tax rules are stored as configuration, pending the accountant's advice.

## Authentication and authorisation (Supabase Auth)

- Supabase Auth for sign-in. Use email and password, plus one-time codes, with passwordless as an option later.
- Row Level Security enabled on every table in the public schema. No table is open by default.
- Customers can read and write only their own profile, searches, bookings, passengers, and payments.
- `support` can read bookings and payments for case handling, with no write access to money fields.
- `admin` manages providers, pricing rules, and users, with actions logged.
- Server code uses the user's session for reads. The service role key is used only in server routes that have passed an explicit role check, and never in client code.
- Role changes go through a logged admin action. A user cannot set their own role.

## Payments

- A `PaymentProvider` interface with `createPayment`, `verifyWebhook`, `refund`, and `getStatus`.
- Payment is confirmed only by a verified webhook or a server-side status check. Never by the browser redirect.
- Webhook handlers verify the provider's signature and store event IDs so duplicates are ignored.
- We never store card numbers. Card data is entered on the provider's hosted page or SDK.

## Flight supply

- A `FlightSupplier` interface with `search`, `priceOffer`, `createOrder`, `issueTicket`, `cancelOrder`, `getOrder`.
- The mock adapter implements the full interface with deterministic data, so the whole booking flow can be built and tested before any supplier contract exists.
- The Duffel adapter is written only after sandbox access is confirmed.
- Supplier responses are validated before they reach booking logic.

## Security

- All secrets server-side. No secrets in the repo, in the client bundle, or in logs.
- Input validation at every server boundary (zod or equivalent).
- Rate limiting on search and login.
- Dependencies pinned and scanned. Secret scanning enabled on the GitHub repo.
- Passport and date-of-birth data encrypted at rest and access-logged. Retention period set by legal advice (NDPA).
- HTTPS only, secure cookies, CSRF protection on state-changing routes.

## Testing

- Unit tests for the booking state machine, money handling, and time-zone logic.
- Contract tests for each adapter, run against the mock and against sandbox when available.
- End-to-end test of search → quote → payment (test mode) → booking → ticketing (mock) before any real provider is connected.

## Proposed milestone 1 (after approval)

1. Scaffold the monorepo and Next.js app, with lint, type checking, and tests.
2. Supabase schema, migrations, and RLS policies, with tests that check RLS.
3. Auth flow: sign up, sign in, sign out, role model.
4. Core domain package: money, time zones, booking state machine.
5. Mock flight supplier and search results page.

Nothing in milestone 1 needs a supplier, payment, or regulatory approval.

## Environment limits to note

Package installs and network access for package managers are currently disabled for this account, so I can write the code but cannot run `npm install`, the build, or the tests in this environment. Enabling package installs in network settings is needed before milestone 1 can be verified.
