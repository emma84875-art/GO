# Implementation plan v2

Status: **Revised for review.** Incorporates the owner's decisions of 12 Nov 2026. Supersedes v1 (commit `02f993d`).

Related documents:
- `01-commercial-dependencies.md`: suppliers, payments, IATA, compliance (external dependency register)
- `02-architecture.md`: architecture principles and data model
- `03-milestone-1-status.md`: what is built and verified
- `05-duffel-enquiry.md`: supplier enquiry draft (not sent)
- `06-booking-payment-fulfilment-policy.md`: **binding money-safety policy**
- `07-launch-route-strategy.md`: launch routes (proposal)
- `08-tooling-recommendations.md`: email and monitoring (recommendations, nothing purchased)
- `09-brand-identity.md`: brand direction and tokens (first pass)

---

## 0. Ground rules

1. **We never take a customer's money before we know the flight can be ticketed.** This is the first rule of the platform. See `06`.
2. No production payment or ticketing is activated without written approval from the provider and the owner.
3. No supplier, payment or other commercial agreement, subscription or paid service is bought or signed without the owner's approval.
4. No supplier capability is assumed. A capability is "confirmed" only when the provider has confirmed it in writing.
5. Sandbox and production are configured separately, and production adapters refuse to load unless approved.
6. Credentials come from the provider after approval. None are created, guessed or committed.
7. Legal and data-protection matters go to qualified Nigerian professionals. Ticketing arrangements go to an authorised supplier or consolidator.

---

## 1. Frontend and backend architecture

**Decided:**
- **Frontend and backend:** Next.js (App Router) and TypeScript. No second framework.
- **Background jobs:** **pg-boss**, a job queue stored in our PostgreSQL database. No additional vendor. Jobs are defined in a separate `packages/jobs` module so the queue can be swapped later without touching business logic.
- **Workspace tooling:** **npm workspaces**, already in use.
- **Hosting:** Vercel (application) and Supabase (Postgres, Auth, Storage). Region to be confirmed for latency to Nigeria and supplier APIs.

**Repository layout:**

```
apps/web               Next.js app: public site, search, booking, account, admin
packages/core          domain: money, time, booking and ticket status, validation
packages/flights       FlightSupplier interface, mock adapter, Duffel adapter (later)
packages/payments      PaymentProvider interface, mock adapter, Paystack, Flutterwave (later)
packages/crypto        crypto payment interface (later, separate specification)
packages/jobs          pg-boss setup, job definitions, workers
packages/ui            design tokens and shared components
supabase/              migrations, tests, sandbox seeds only
brand/                 logo files
docs/                  decisions, policies, plans, enquiries
```

**Job architecture (modular):**
- Each job is a small, named, idempotent function with an input schema.
- Jobs are enqueued by domain services, never by UI code.
- Every job records its outcome in `booking_events` where it affects a booking.
- Retry policy is set per job. Money-moving jobs never retry blindly; they check current state first.

---

## 2. Database structure and relationships

The current schema is in `supabase/migrations/20261112000000_initial_schema.sql`, with 13 database checks passing.

**Additions for milestone 2 and later:**

| Table | Purpose | Key constraints |
|---|---|---|
| `offers` | Snapshot at quote time (supplier offer ID, prices, expiry, fare rules) | Expiry enforced; re-priced before payment |
| `booking_events` | Ordered history of every booking state change | Append-only |
| `payment_authorisations` | Authorisation holds per booking (amount, provider reference, expiry) | One active authorisation per booking; amount fixed |
| `payment_captures` | Captures per authorisation | Captured total ≤ authorised amount; only after ticketing |
| `refunds` | Refunds and reversals per payment | Amount ≤ captured amount |
| `supplier_orders` | Supplier order IDs and raw status | Unique per supplier and order ID |
| `ticket_jobs` | Ticketing attempts with idempotency key | One active attempt per booking |
| `fx_rates` | Rate snapshots used per booking | Immutable once used |
| `provider_configs` | Enabled providers per environment | Changes logged; production change needs two admins |
| `webhook_events` | Received provider events | Unique per provider and event ID |

**Invariants (enforced in schema or tests):** the six money-safety invariants in `06`, plus integer minor units and `timestamptz` throughout.

**Passenger travel documents:** needed by airlines for ticketing. Storage waits for the data-protection review and a field-encryption design. Milestone 3 at the earliest.

---

## 3. Authentication and user permissions

- **Authentication:** Supabase Auth. Email and password with verified email. Multi-factor authentication required for `support` and `admin`, optional for customers.
- **Roles:** `customer`, `support` (read-only on money fields, can add notes), `admin` (manages users, providers and pricing, all actions logged).
- **Enforcement:** database row-level security (implemented and tested), then server checks in every server action, then UI hiding (cosmetic only).
- **Role changes:** admin only, through a logged action. A user cannot change their own role (enforced by trigger, tested).
- **Sessions:** secure HTTP-only cookies via Supabase SSR helpers, refresh-token rotation, idle timeout for staff.

---

## 4. Flight supplier integration and adapters

- **Interface:** `FlightSupplier` with `search`, `priceOffer`, `createHold`, `createOrder`, `issueTicket`, `cancelOrder`, `getOrder`. Booking logic depends only on this interface.
- **Mock adapter:** built in milestone 2, used for all development and tests until a sandbox is confirmed.
- **Duffel adapter:** built after Duffel sandbox access is confirmed in writing (milestone 3). Holds are used only where the offer's `requires_instant_payment` is `false`, and the code checks that flag per offer.
- **Contract test suite:** every adapter must pass the same tests: UTC times with correct IANA zones, expired offers rejected, idempotent order creation, one ticket per passenger or a clear failure, errors mapped to retryable, customer-fixable and terminal categories, raw payloads stored redacted.
- **Coverage is unverified.** No supplier is assumed to cover any airline or route until its response confirms it (see `07`).

---

## 5. Flight search and booking workflows

Full order of operations is in `06`. Summary:

1. **Search:** validated input, supplier search, prices in NGN with FX rate and timestamp recorded.
2. **Quote:** offer re-priced with the supplier; price locked for a short window.
3. **Passenger details:** validated against nationality and destination rules, stored as data.
4. **Hold (preferred):** supplier hold created where the offer allows it. Records the payment deadline and price guarantee. Where no hold is possible, the fare is re-priced immediately before payment.
5. **Authorise:** customer's payment method authorised for the total. **Not captured.**
6. **Ticket:** supplier paid and tickets issued. Every passenger's ticket number verified.
7. **Capture:** only after ticketing is confirmed. If ticketing failed, the authorisation is released.
8. **Confirm:** itinerary and ticket numbers sent to the customer.

**Blocked until confirmed:** steps 5 to 7 cannot run in production until either a provider's authorisation and capture for NGN cards is confirmed (Option A), or a funded supplier balance arrangement is confirmed (Option B, owner decision). See `06`.

---

## 6. Payment orchestration (fiat and crypto)

**Decided:**
- **Primary provider:** **Paystack** for Naira payments, including cards and bank transfer, subject to merchant approval and to confirmation of the authorisation and capture capability for Nigerian merchants.
- **Alternative provider:** **Flutterwave**, behind the same interface, to be evaluated in the same way.
- **International cards (Stripe):** evaluated only if Nigerian merchant eligibility is confirmed. Not started.
- **Cryptocurrency:** separate payment option, built to your crypto specification (not yet in this repo). Requires Nigerian regulatory review before any live use.

**Interface:** `PaymentProvider` with `authorise`, `capture`, `release`, `refund`, `verifyWebhook`, `getStatus`. Booking logic never branches on the provider.

**Current facts that limit the design (see `06`):**
- Paystack's documented card pre-authorisation covers South African merchants and ZAR only. Nigeria is not confirmed.
- Paystack documentation says a travel agency needs an IATA licence for international payments (earlier research, to be confirmed with Paystack).

**Payment rules:**
- Payment is confirmed by verified webhook or server-side status check, never by the browser redirect.
- Webhook signatures verified; event IDs stored for idempotency.
- Card data never touches our servers (hosted page or provider SDK).
- Daily reconciliation against provider settlement reports, with differences raised as admin tasks.

---

## 7. Booking management and ticket issuance

- **Customer view:** bookings with the customer-facing label from `customerStatusLabel`. A booking shows "Ticketed" only when ticket numbers are stored.
- **Ticketing job:** runs after the supplier payment step. Idempotent with a per-booking key. Success stores ticket numbers and sets `ticketed`. Failure sets `ticketing_failed`, releases the authorisation, and alerts support.
- **No silent retries of money-moving steps.** Retries happen from the admin dashboard with a recorded reason.
- **Authority to issue tickets:** Duffel's Managed Content (to be confirmed in writing), or an IATA route we do not yet hold. Production ticketing stays off until the authority is confirmed.
- **Changes and cancellations:** only where the supplier and fare rules allow. Refunds follow the fare rules returned by the supplier.
- **Notifications:** transactional email provider to be approved (see `08`). Templates reviewed by counsel before launch.

---

## 8. Administrative dashboard

- **Bookings:** search by reference, customer, passenger name, route, status; full event history.
- **Payments:** authorisations, captures, releases and refunds; reconciliation differences.
- **Ticketing:** failed or stuck jobs; retry with a reason; manual review queue.
- **Customers:** profile view (no passport numbers by default); role changes (admin only).
- **Providers:** enable or disable per environment. Production enablement needs two admins.
- **Pricing rules:** markup and fees, with effective dates and change history.
- **Audit log:** searchable, read-only. Append-only at the database level.
- **Alerts:** capture-after-ticketing failures, stuck jobs and reconciliation gaps shown first.

Access follows section 3: `support` reads and adds notes; `admin` acts.

---

## 9. Security and regulatory requirements

**Technical controls:**
- Secrets server-side only. Never in the client bundle, logs or repository.
- Input validation at every server boundary.
- Rate limits on login, search and payment initiation.
- Webhook verification and idempotency everywhere.
- Field-level encryption for travel documents and dates of birth, with access logging (milestone 3).
- Personal data and card-related data redacted from logs and error reports.
- Dependency and secret scanning on the GitHub repository.
- Security headers, CSRF protection on state-changing routes, HTTPS only.
- Supabase backups and point-in-time recovery, with a tested restore.

**Regulatory (qualified Nigerian counsel to review before launch):**
- **Nigeria Data Protection Act 2023:** privacy notice, lawful basis, processor agreements (supplier, payment, email, monitoring, hosting), cross-border transfer assessment, retention schedule, data subject requests, breach notification.
- **Consumer protection and airline ticketing:** refund and change terms, fare-rule disclosure, complaints.
- **Payments:** whether any part of our flow triggers CBN licensing (for example, holding customer funds, or settlement through a third party).
- **Crypto:** separate review before any use.
- **Tax:** VAT and service fees, FX treatment, invoicing.
- **AML and KYC:** assessment for payment flows and high-value bookings.

**Operational:** named security and data-protection owners, incident response plan with contacts, quarterly staff access reviews.

---

## 10. Testing and deployment

**Testing layers:**
1. Unit tests for money, time and status logic (22 passing).
2. Database tests for RLS, constraints, triggers and the audit log (13 passing against PostgreSQL 16).
3. Adapter contract tests, mock first, sandbox later.
4. Money-safety tests: the six invariants in `06`, tested before any payment provider is connected.
5. Integration tests: search → quote → hold → authorise → ticket (mock) → capture (mock) → confirm, including every failure path.
6. End-to-end browser tests (Playwright): sign-up, search, booking, admin actions.
7. Accessibility checks (axe and Lighthouse) on search and checkout, using the contrast rules in `09`.
8. Security checks: dependency audit, secret scanning, penetration test before launch.

**Environments:**

| | Local | Preview | Staging | Production |
|---|---|---|---|---|
| App | dev server | per pull request | `main` branch | release tag |
| Database | local Postgres | branch database | separate project | production project |
| Providers | mock | mock | sandbox only | approved providers only |
| Data | synthetic | synthetic | synthetic | real |

**Pipeline:** lint, type check, unit tests, database tests, build, preview deploy. Staging deploys on merge to `main`. Production needs a release tag, a second reviewer, and passing end-to-end tests on staging.

**Database changes:** migrations only, reviewed, applied through the Supabase CLI. No manual production changes.

**Monitoring:** Sentry recommended for error tracking (see `08`, not yet approved). Uptime and log tools to be researched.

---

## 11. Dependencies: what we can build now, and what waits

### A. Can build now, with no external dependency

| Work | Phase |
|---|---|
| Next.js app scaffold, TypeScript, linting, CI | 1 |
| Brand tokens and design system (light and dark), public layout | 1 |
| Sign-up, sign-in, profile, role model (uses existing schema) | 1 |
| Mock search results page | 1 |
| pg-boss job setup and tests | 2 |
| Booking state machine in the app, customer status labels | 2 |
| Mock supplier booking flow with mock authorisation and capture | 2 |
| Money-safety invariant tests against mocks | 2 |
| Customer bookings and account pages | 2 |
| Admin dashboard shell, bookings list, audit log view (mock data) | 2 |
| Email templates (drafts for counsel review) | 2 |

**Blocked by the package-install setting:** all of the above that needs the Next.js build, and any test that needs an installed package. Enabling package installs for this environment is required before Phase 1 can be built and verified.

### B. Waiting on a provider, agreement or approval

| Work | Waiting on | Status |
|---|---|---|
| Duffel sandbox adapter | Duffel sandbox access | Enquiry drafted, **not sent** |
| Duffel production adapter | Commercial agreement; Nigerian merchant eligibility | Not started |
| Supplier holds | Confirmed per offer (`requires_instant_payment`) and per airline | Only some airlines confirmed by Duffel's guide |
| Supplier-paid ticketing | Confirmed funding arrangement (Duffel balance) | Not confirmed |
| Ticketing authority in production | Written confirmation from Duffel or a consolidator | Not started |
| Paystack payments | Merchant approval; authorisation and capture for NGN cards confirmed | Not started |
| Flutterwave payments | Merchant approval; authorisation and capture confirmed | Not started |
| Stripe international cards | Confirmed Nigerian merchant eligibility | Unverified |
| Amadeus or Sabre | Commercial agreement; Amadeus self-service status unverified | Not started |
| FX rate provider | Provider choice and agreement | Not started |
| Transactional email (Postmark recommended) | Your approval, DPA, data-residency check, DNS setup | Recommendation only (`08`) |
| Error monitoring (Sentry recommended) | Your approval, DPA, data-residency check | Recommendation only (`08`) |
| Route and schedule data (OAG or Cirium) | Your approval and licence purchase | Not started (`07`) |

### C. Waiting on regulators, counsel or the trademark process

| Work | Waiting on | Status |
|---|---|---|
| Live customer data | NDPA review by Nigerian counsel; privacy notice; processor agreements | Not started |
| Storing travel document numbers | Encryption design and retention rule | Not started |
| Live payment collection | Payments and licensing review; provider approval | Not started |
| Cryptocurrency payments | Nigerian regulatory review; your crypto specification | Not started |
| Own IATA accreditation | NCAA certificate; IATA requirements (27 items on IATA's Nigeria page) | Not started |
| Consumer terms and refund policy | Counsel review | Not started |
| Product name and logo | Trademark clearance search by counsel | Not started |

---

## 12. Implementation phases

**Phase 0 (complete):** audit, research, policy, route and tooling recommendations, brand first pass.

**Phase 1: foundation (blocked on package installs).** Next.js scaffold, CI, brand tokens in the app, sign-up and sign-in, profile, mock search page. *Exit: a signed-in customer searches mock data in light and dark themes, with accessibility checks passing.*

**Phase 2: booking on mocks (no external dependency).** Quote, hold, passenger details, mock authorisation, mock ticketing, mock capture, customer bookings, admin shell, pg-boss jobs, and the money-safety invariant tests. *Exit: full booking flow and all failure paths pass on mocks.*

**Phase 3: Duffel sandbox (needs Duffel sandbox access).** Duffel adapter: search, price, hold, order, ticket in sandbox, with contract tests. *Exit: contract suite passes against the sandbox.*

**Phase 4: payments in test mode (needs Paystack test access and the authorisation confirmation).** Paystack authorisation, capture and release in test mode; webhooks; reconciliation. Flutterwave only if needed. *Exit: test-mode bookings complete and every failure path releases money correctly.*

**Phase 5: launch readiness (needs every B and C blocker closed).** Security review, penetration test, counsel sign-off, privacy notice, supplier and payment agreements in force, support process, staging soak test, rollback drill. *Exit: launch checklist complete.*

**Phase 6: production launch,** starting with Wave 1 routes from `07`, with a capped daily booking volume.

**Later:** Stripe (if eligible), crypto (if approved), more routes, more suppliers, own IATA accreditation.

---

## 13. Decisions

**Resolved by the owner (12 Nov 2026):**

| Decision | Outcome |
|---|---|
| Background jobs | pg-boss |
| Workspace tooling | npm workspaces |
| Booking order | Holds where supported; revalidate where not; authorise then capture where supported; never charge without a defined fulfilment and failure process |
| Payment priority | Paystack first (Naira cards and bank transfer); Flutterwave as alternative |
| Brand | Midnight Navy, Deep Teal, Sea Glass, Champagne, Porcelain; Inter; light and dark; original mark |
| Tooling | Recommend first; no purchase without approval |
| Launch routes | Nigeria first, international from day one; proposal in `07` |
| Ownership | Owner makes business decisions; counsel for legal and data protection; authorised supplier or consolidator for ticketing |

**Still open, needing your decision:**

1. **Approve the money-safety policy** (`06`), including the choice between Option A and Option B for NGN payments. Option B needs a funding decision from you.
2. **Approve the email and monitoring recommendations** (`08`) before any signup.
3. **Confirm the Wave 1 route scope** (`07`), and whether to fund an OAG or Cirium data licence.
4. **Confirm the brand details** (`09`): the two extra neutral colours, the logo concept, and the product name pending a trademark search.
5. **Engage Nigerian counsel** for data protection, consumer terms, payment licensing and the trademark search. Who is the named contact?
6. **Confirm the package-install setting** is enabled, so Phase 1 can begin.

---

## 14. Next steps

1. You review `06` and answer the open decisions above.
2. You send the Duffel enquiry (`05`) after filling in the placeholders, or ask me to prepare a Paystack enquiry on the same basis.
3. You approve or amend the email and monitoring recommendations.
4. Package installs are enabled through the approved network setting. I cannot change that setting from inside the environment.
5. Once steps 1 and 4 are done, Phase 1 starts.
