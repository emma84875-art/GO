# Implementation plan (for review)

Status: **PROPOSAL. Awaiting approval.** No major implementation starts until this plan is approved. Built on `docs/01-commercial-dependencies.md`, `docs/02-architecture.md`, and the milestone 1 status in `docs/03-milestone-1-status.md`.

Current state of the repo: domain core (money, booking status, time), a mock flight supplier, the initial database schema with row-level security, and 35 automated checks (22 unit tests, 13 database checks). The Next.js app does not exist yet.

---

## 0. Ground rules

- No supplier, payment, or FX integration goes to production until its row in the dependency table (section 11) is confirmed in writing.
- Sandbox and production are configured separately. Production adapters refuse to load unless their provider is in `APPROVED_PROVIDERS`.
- No credentials are created, guessed, or hard-coded. Each provider's keys come from that provider after approval.
- A booking is never presented as a ticket until the supplier returns ticket numbers.

---

## 1. Frontend and backend architecture

**Frontend:** Next.js (App Router), TypeScript, Tailwind CSS. Server Components by default. Client Components only for interactive parts (search filters, booking forms, payment handoff).

**Backend:** Next.js route handlers and server actions for request/response work. Long-running work (supplier ticketing, payment reconciliation, retries, email) runs as background jobs, so a slow supplier response never blocks a customer request.

**Background jobs (decision required):**
- Option A: pg-boss, a job queue stored in our own Postgres. No extra vendor, simple to operate.
- Option B: a hosted workflow service (for example Inngest or Trigger.dev). Better retry tooling and observability, but adds a vendor and a data-processing agreement.
- *Recommendation:* Option A for milestone 2, reviewed before production.

**Repository layout** (as in `02-architecture.md`):

```
apps/web               Next.js app: public site, search, booking, account, admin
packages/core          domain: money, time, booking state machine, validation
packages/flights       FlightSupplier interface, mock, Duffel (later)
packages/payments      PaymentProvider interface, mock, providers (later)
packages/crypto        crypto payment interface (later, separate spec)
packages/jobs          job definitions and workers
packages/ui            shared components and design tokens
supabase/              migrations, tests, seeds (sandbox data only)
docs/                  decisions, audits, plans, enquiries
```

**Workspace tooling (decision required):** npm workspaces (already used in `package.json`) or pnpm workspaces (faster, stricter dependency isolation). *Recommendation:* pnpm, if you agree to the extra tool.

**Hosting:** Vercel for the Next.js app; Supabase for Postgres, Auth and Storage. Region choice to be confirmed for latency to Nigeria and to supplier APIs.

---

## 2. Database structure and relationships

The schema in `supabase/migrations/20261112000000_initial_schema.sql` is the starting point.

**Current tables and relationships:**

- `profiles` (1 per auth user) → `searches`, `bookings`
- `bookings` (1 per booking) → `booking_segments` (1..n), `passengers` (1..n), `payments` (0..n), `tickets` (0..n, one per passenger segment set)
- `audit_log` (append-only, linked by text reference to any entity)

**Planned additions (milestone 2 and later):**

| Table | Purpose | Key constraints |
|---|---|---|
| `offers` | Snapshot of an offer at quote time (supplier offer ID, prices, expiry, fare rules) | Expiry enforced; price re-checked before payment |
| `booking_events` | Ordered history of status changes per booking | Append-only; referenced by the audit log |
| `refunds` | Refund requests and outcomes per payment | Amount ≤ captured amount, enforced in code and by check |
| `fx_rates` | Rate snapshots used per booking | Immutable once used |
| `provider_configs` | Which providers are enabled per environment, and their mode | Changes logged; production change requires admin role |
| `supplier_orders` | Supplier order IDs and raw status per booking | One per booking; unique on supplier + order ID |
| `ticket_jobs` | Ticketing attempts and results | Idempotency key per booking so retries never double-issue |
| `webhook_events` | Received provider webhook IDs | Unique on provider + event ID |

**Money and time rules (already enforced):**
- All amounts are integers in minor units with a currency code.
- All timestamps are `timestamptz`. Display uses the airport's time zone.

**Open design question:** passenger travel-document numbers. They are needed by most airlines for ticketing. Storage requires field-level encryption, access logging and a retention rule (section 9). Decision needed before milestone 3.

---

## 3. Authentication and user permissions

**Authentication:** Supabase Auth. Email and password with verified email; one-time-code sign-in as an option. Multi-factor authentication for staff roles (required) and optional for customers.

**Roles:**
- `customer`: own profile, own searches, own bookings, own passengers and tickets
- `support`: read all bookings, payments and tickets for case handling; can add internal notes; cannot change money or status fields
- `admin`: manage users and roles, provider configuration, pricing rules; all admin actions logged

**Enforcement layers:**
1. Database row-level security (already implemented and tested).
2. Server checks in route handlers and server actions. Every server action states the role it requires.
3. UI hides actions the role cannot use. This is cosmetic only; the server and database are the real controls.

**Role changes:** only admins, through a logged server action, using the service role. Users cannot change their own role (enforced by trigger and tested).

**Session handling:** secure, HTTP-only cookies via Supabase SSR helpers. Refresh-token rotation. Idle timeout for staff sessions.

---

## 4. Flight supplier integration and adapter architecture

**Interface:** `FlightSupplier` (`packages/flights/src/supplier.ts`) with `search`, `priceOffer`, `createOrder`, `issueTicket`, `cancelOrder`, `getOrder`. Booking logic depends only on this interface.

**Adapters:**
- `mock`: deterministic, for development and tests. Built in milestone 2.
- `duffel`: built only after Duffel sandbox access is confirmed (milestone 3).
- Future: Amadeus or Sabre, if a commercial agreement makes them viable.

**Each adapter must pass the same contract test suite:**
- Search returns offers with currency, expiry and segments in UTC with IANA zones.
- Pricing a stale offer fails cleanly, and the booking flow re-prices before payment.
- Order creation is idempotent using our booking ID as the key.
- Ticketing returns one ticket number per passenger, or a clear failure.
- Errors are mapped to our error categories (retryable, customer-fixable, terminal).
- Raw supplier payloads are stored (redacted) for audit and support.

**Mode separation:** the adapter's mode (`mock`, `sandbox`, `production`) comes from configuration. Production mode requires approval (section 0).

**Rate limits and caching:** search results cached for a short period (minutes, not hours) because prices change. Cache keys include passenger count, cabin and dates.

---

## 5. Flight search and booking workflows

**Search:**
1. Customer enters origin, destination, dates, passengers, cabin and display currency.
2. Server validates input (airport codes, date not in the past, passenger range).
3. Server calls the active supplier. Results are shown with display prices in NGN (or the chosen currency), with FX rate and timestamp recorded.
4. Results show local departure and arrival times, durations, and stops.

**Quote:** selecting an offer creates a `quoted` booking with a price-lock window (for example 15 minutes). The offer is re-priced with the supplier at this step.

**Booking and payment order (decision required):**
- Option A: take payment first, then create the supplier order and ticket. Simplest and safest for money, but a failed supplier order needs a refund.
- Option B: create a supplier hold first (if the supplier supports holds), take payment, then ticket. Fewer refunds, but depends on hold support and hold expiry rules.
- *Recommendation:* Option A for launch, because it needs no hold support and keeps money handling simple. Confirm with Duffel which option their Managed Content supports.

**Passenger details:** collected after quote. Name must match travel documents exactly. Validation rules are per nationality and destination, stored as data.

**Status transitions:** as defined in `packages/core/src/booking-status.ts`. Every transition writes to `booking_events` and the audit log.

**Failure handling:**
- Price changed at payment: show the new price; customer confirms or cancels.
- Offer expired: return to search.
- Supplier order failed after payment: automatic refund flow, customer notified, support alerted.
- Ticketing failed: refund flow, not silent retries. Retries only through the admin dashboard with a reason.

---

## 6. Payment orchestration (fiat and cryptocurrency)

**Interface:** `PaymentProvider` with `createPayment`, `verifyWebhook`, `getStatus`, `refund`. Provider-independent booking logic.

**Fiat, Naira first:**
- Paystack or Flutterwave, for Naira cards and bank transfer, subject to merchant approval (see section 11).
- Payment is confirmed only by a verified webhook or a server-side status check, never by the browser redirect.
- Webhook signatures verified; event IDs stored for idempotency.

**Fiat, international cards:**
- Stripe, subject to confirmed eligibility for a Nigerian-incorporated business.

**Cryptocurrency:**
- Separate payment option, built to your crypto payment specification (not yet provided to this repo).
- Requires its own regulatory review in Nigeria before any live use. Nothing is built or enabled until that review is complete.
- Same orchestration interface, so bookings don't branch on payment method.

**Reconciliation:** a daily job compares our payment records with provider settlement reports. Differences create admin tasks.

**Refunds:** initiated by admins or by automated failure flows. Refund amount cannot exceed the captured amount (enforced in code and by database check).

**Card data:** never touches our servers. Hosted payment pages or provider SDKs only.

---

## 7. Booking management and ticket issuance

**Customer view:** list of bookings with the customer-facing label from `customerStatusLabel`. Itinerary, passengers, ticket numbers (only when issued), receipts, and change or cancellation requests (where supported by the supplier).

**Ticket issuance:**
- Runs as a background job after payment is confirmed and the supplier order exists.
- Idempotent: one ticketing attempt per booking at a time, with an idempotency key.
- On success: ticket numbers saved, ticket status set to `ticketed`, customer notified with the itinerary.
- On failure: ticket status `ticketing_failed`, refund flow started, admin alerted.

**Ticket issuance authority:** depends on the route we choose (section 11). Until a written agreement exists, ticketing runs only against the mock and sandbox. Production ticketing does not start without it.

**Changes and cancellations:** supported only where the supplier and fare rules allow. Refund amounts follow the fare rules returned by the supplier, not our own rules.

**Notifications:** email (transactional provider to be chosen) and in-app. Templates reviewed by legal before launch.

---

## 8. Administrative dashboard

**Scope for launch:**
- Bookings: search by reference, customer, passenger name, route, status. Full history view.
- Payments: list, status, reconciliation differences, refund actions.
- Ticketing: failed jobs, retry with reason, manual review queue.
- Customers: profile view (no passport numbers displayed by default), role management (admin only).
- Providers: enable or disable providers per environment; production enable requires two admins.
- Audit log: searchable, read-only.
- Pricing rules: markup and fee settings, with effective dates and change history.

**Access:** `support` sees bookings and payments read-only plus notes; `admin` sees all and can act.

**Build approach:** server-rendered pages with the same role checks as customer pages. No separate admin API surface.

---

## 9. Security and regulatory requirements

**Technical controls:**
- Secrets only on the server; no secrets in the client bundle, logs, or the repo.
- Input validation at every server boundary.
- Rate limiting on login, search and payment initiation.
- Webhook signature verification and idempotency everywhere.
- Field-level encryption for travel document numbers and dates of birth, with access logging.
- Log redaction for personal data and payment references.
- Dependency scanning and secret scanning on the GitHub repository.
- Security headers, CSRF protection on state-changing routes, HTTPS only.
- Backups and point-in-time recovery on Supabase, with a tested restore.

**Regulatory (needs legal advice before launch):**
- **Nigeria Data Protection Act 2023:** privacy notice, lawful basis, data processor agreements (Duffel, payment providers, hosting), cross-border transfer assessment, retention schedule, data subject request process, breach notification process.
- **Consumer protection and airline ticketing rules:** refund and change terms, fare-rule disclosure, complaint handling.
- **Payments:** confirm whether any part of our flow (for example holding customer funds, or settlement through a third party) triggers CBN licensing.
- **Crypto:** separate legal review before any use (section 6).
- **Tax:** VAT and service-fee treatment in Nigeria, FX treatment, and invoicing rules.
- **AML and KYC:** assess obligations for payment flows and high-value bookings.

**Operational controls:**
- Named owner for security and data protection.
- Incident response plan and contact list.
- Access reviews for staff accounts each quarter.

---

## 10. Testing and deployment

**Testing layers:**
1. Unit tests: domain logic (money, time, booking state). Already in place (22 tests).
2. Database tests: RLS, constraints, triggers. Already in place (13 checks against PostgreSQL 16), run in CI against a disposable database.
3. Adapter contract tests: each supplier and payment adapter runs the same suite. Mock first; sandbox later.
4. Integration tests: search → quote → payment (test mode) → booking → ticketing (mock or sandbox).
5. End-to-end browser tests (Playwright): sign-up, search, booking, admin actions.
6. Accessibility and performance checks on search and checkout (Lighthouse and axe).
7. Security checks: dependency audit, secret scanning, basic penetration test before launch.

**Environments:**

| | Local | Preview | Staging | Production |
|---|---|---|---|---|
| App | dev server | per pull request (Vercel) | main branch | release tag |
| Database | local Postgres or Supabase local | Supabase branch | separate Supabase project | production project |
| Providers | mock | mock or sandbox | sandbox only | approved providers only |
| Data | synthetic | synthetic | synthetic | real |

**Pipeline:** lint, type check, unit tests, database tests, build, then preview deploy. Staging deploys on merge to `main`. Production deploys require a release tag, a second reviewer, and passing end-to-end tests on staging.

**Database changes:** migrations only, reviewed, applied through the Supabase CLI. No manual changes in production.

**Monitoring:** error tracking (for example Sentry, to be chosen), uptime monitoring, job queue monitoring, payment and ticketing failure alerts to the on-call owner.

**Launch checklist:** all section 11 blockers closed, legal review signed off, privacy notice published, support process staffed, rollback plan tested.

---

## 11. Features we can build now, and what depends on others

### A. Can build now (no external dependency)

| Work | Milestone |
|---|---|
| Next.js app scaffold, TypeScript, linting, CI | 1 |
| Sign-up, sign-in, sign-out, profile, role model (uses existing schema) | 1 |
| Design system and layout (public site, account pages) | 1 |
| Mock flight search results page | 1 |
| Booking state machine in the app, status labels | 2 |
| Mock supplier end-to-end booking flow with mock payment | 2 |
| Booking history and customer account pages | 2 |
| Admin dashboard shell, bookings list, audit log view (with mock data) | 2 |
| Background job system (pg-boss) and its tests | 2 |
| Email templates (drafts for legal review) | 2 |

### B. Depends on an external provider or agreement

| Work | Depends on | Status |
|---|---|---|
| Duffel sandbox adapter | Duffel sandbox access | Enquiry drafted, **not sent** |
| Duffel production adapter | Duffel commercial agreement, Nigerian eligibility | Not started |
| Ticket issuance in production | Written confirmation of ticketing authority (Duffel Managed Content or IATA route) | Not started |
| Paystack or Flutterwave payments | Merchant approval (CAC, tax and director documents) | Not started |
| Stripe international cards | Confirmed Nigerian merchant eligibility | Unverified |
| Amadeus or Sabre | Commercial agreement; Amadeus self-service status unverified | Not started |
| FX rate provider | Provider choice and agreement | Not started |
| Email and SMS providers | Provider choice and agreement | Not started |

### C. Depends on regulatory approval or legal advice

| Work | Depends on | Status |
|---|---|---|
| Live customer data processing | NDPA review, privacy notice, processor agreements | Not started |
| Storing travel document numbers | Encryption design and retention rule, from the data-protection review | Not started |
| Live Naira payment collection | Payment licensing review | Not started |
| Cryptocurrency payments | Crypto regulatory review and your crypto specification | Not started |
| Own IATA accreditation | NCAA certificate, IATA process (27 requirements, see IATA page) | Not started |
| Consumer terms and refund policy | Legal review | Not started |

---

## 12. Implementation phases

**Phase 0 (current):** audit, dependency research, Duffel enquiry drafted, this plan. *Exit: plan approved.*

**Phase 1: foundation (no external dependencies).** Next.js scaffold, CI, auth flows, profile, design system, mock search page. *Exit: a signed-in customer can search with mock data.* Needs package installs enabled.

**Phase 2: booking workflow on mocks.** Quote, passenger details, mock payment, mock supplier order, status transitions, customer bookings, admin shell, job system. *Exit: full booking flow passes end-to-end tests on mocks.*

**Phase 3: Duffel sandbox.** Duffel adapter against sandbox: search, price, order, ticket (sandbox). Contract tests. *Exit: contract suite passes against Duffel sandbox.* Needs Duffel sandbox access.

**Phase 4: payments in test mode.** Paystack or Flutterwave test mode through the payment interface; webhook handling; reconciliation job. Stripe only if eligibility is confirmed. *Exit: end-to-end test-mode bookings with payments.* Needs provider test accounts.

**Phase 5: launch readiness.** Security review, penetration test, legal sign-off, privacy notice, support process, staging soak test, rollback drill. *Exit: launch checklist complete.* Needs all section 11 B and C blockers closed.

**Phase 6: production launch in Nigeria** with international departures, starting with a limited set of routes and a capped daily booking volume. *Exit: stable for agreed period.*

**Later:** Stripe (if eligible), crypto (if approved), additional suppliers, own IATA accreditation, hotels or other products.

---

## 13. Decisions needed from you

1. **Background jobs:** pg-boss (recommended) or a hosted workflow service?
2. **Workspace tooling:** npm workspaces (current) or pnpm?
3. **Booking and payment order:** take payment first (recommended) or use supplier holds?
4. **Payment provider priority:** Paystack or Flutterwave first? (Both can be built behind the same interface.)
5. **Design direction:** do you have a brand, colours or reference sites for the premium look? If not, I'll propose three directions for you to choose from before building the UI.
6. **Email provider and monitoring tools:** happy with my suggestions to be confirmed, or do you have preferences?
7. **Launch routes:** which first routes (for example Lagos to London, Dubai, New York) do you want in the first production release?
8. **Ownership:** who in your team owns legal, data protection and ticketing decisions?

---

## 14. Immediate next steps

1. You review this plan and answer section 13.
2. You send the Duffel enquiry (`docs/05-duffel-enquiry.md`) after filling in the placeholders. I have not sent it.
3. Package installs are enabled for this environment through the approved network settings. I can't change that setting from inside the environment.
4. Once steps 1 and 3 are done, I start Phase 1.
