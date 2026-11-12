# Commercial and Regulatory Dependencies

Status as of 2026-11-12. Nothing in this document is a confirmed agreement, approval, or authorisation unless marked **Confirmed**. Everything else is research, and each item needs direct confirmation from the provider or regulator before we depend on it.

Launch-blocking items are marked **[BLOCKER]**.

## 1. Flight supply

### Duffel (recommended first supplier)

Source: duffel.com/pricing and duffel.com/why-duffel/sabre-vs-duffel (fetched 2026-11-12).

- **Onboarding:** Self sign-up, pay-as-you-go tier with no upfront fees. Duffel states "less than 1 minute" to start selling. Sandbox access is expected but not confirmed in this research.
- **Fees (pay-as-you-go):**
  - $3.00 per confirmed order, charged monthly
  - 1% of total order value for Managed Content, charged monthly
  - $2.00 per paid ancillary, charged monthly
  - Search overage: $0.005 per search when the search-to-book ratio exceeds 1500:1
  - 2% FX fee where currency conversion is needed
- **Ticketing:** Managed Content uses Duffel's own IATA accreditation and ticketing authority across five IATA regions, with no extra forms or upfront capital. Enterprise tier lets us use our own IATA or ARC accreditation, at bespoke pricing.
- **Not stated on the pricing page:** minimum commitments, ticketing fees, order-change fees, eligibility criteria for Nigerian-based companies. These must be asked directly.
- **Open questions for Duffel sales:**
  1. Will Duffel contract with a Nigerian-incorporated company, and what entity documents do they require?
  2. Does Managed Content ticketing cover international departures from Nigeria, and does it cover ticketing for Nigerian-origin itineraries?
  3. What are the change, refund, and void fees for orders we pass through?
  4. Is there a sandbox with full ticketing, or only search and booking?

### Amadeus

- **Status: UNVERIFIED, likely unavailable on self-service.** A third-party source (ignav.com, a competitor, so not independently verified) says the Amadeus Self-Service APIs have been decommissioned, with Enterprise APIs available "on request". I could not reach Amadeus's own migration page to confirm the date or the affected APIs.
- **Action:** Confirm with Amadeus sales whether self-service flight-offer and order APIs are still available to new accounts, and what an Enterprise agreement costs and requires. Do not start integration work until this is confirmed.

### Sabre

- **Confirmed:** Sabre's API self-service guide says existing customers should contact a Sabre Account Representative. It does not describe a self-service sandbox or production path.
- **Not stated:** whether self-service users can issue tickets. The guide points to ticketing support only via Finder, which requires Sabre EPR credentials.
- **Assessment:** Enterprise and contract-led. Not a practical MVP option without a commercial agreement and likely a larger minimum commitment.
- **Action:** Contact Sabre sales for sandbox access, production terms, and ticketing eligibility.

### Recommendation

Start with Duffel. Put it behind a provider interface (see architecture doc) so Amadeus or Sabre can be added later without rewriting the booking flow.

## 2. Payments

### Paystack (Nigerian Naira, cards, bank transfer)

Sources: support.paystack.com compliance and international eligibility articles (fetched 2026-11-12).

- **Domestic onboarding (Nigerian business):** requires a government ID for each director (BVN validation through iGree with an OTP), the company's CAC documents (RC number: Memorandum and Articles, Certificate of Incorporation, TIN, CAC status report, director details, proof of address), and a bank account in the business's name.
- **SCUML certificate:** required for certain sectors. The published list does not include travel or ticketing businesses.
- **International payments for travel agencies:** Paystack lists travel agencies under extra scrutiny. They must provide compliance documentation, an **IATA licence**, a signed Paystack MSA and indemnity letter, and a live website and social media pages.
- **[BLOCKER]** For Paystack international payments we need an IATA licence or an equivalent accreditation, which we do not have. Domestic Naira payments may be possible sooner; confirm with Paystack support (support@paystack.com).

### Flutterwave (alternative, Naira and cards)

- **Status: UNVERIFIED.** Search results pointed to general Nigerian merchant guides but I could not fetch Flutterwave's official eligibility requirements in this pass.
- **Action:** Request Flutterwave's merchant requirements for a Nigerian travel business, including whether they accept international departures and how they treat travel-agency eligibility. Run this in parallel with Paystack.

### Stripe (international cards)

- **Status: UNVERIFIED.** Stripe's Nigeria card documentation covers accepting local cards from Nigerian customers. It does not state whether a Nigerian-based business can open a Stripe merchant account. Third-party sources are inconsistent.
- **Action:** Confirm with Stripe directly whether a Nigerian-incorporated business is eligible for a merchant account, which settlement currencies apply, and whether travel is a restricted category. Do not build a Stripe integration until this is confirmed.

### Cryptocurrency payments

- Out of scope for this stage. Will follow the separate crypto payment specification and be added through the same provider-independent payment interface. No crypto provider or licence is assumed here. Regulatory treatment of crypto payments for flight bookings in Nigeria needs legal review first.

## 3. IATA accreditation and consolidator options

### IATA travel agent accreditation (Nigeria)

Source: iata.org Nigeria travel agency requirements page (fetched 2026-11-12). The page lists only the first 10 of 27 requirements, so further requirements exist.

- **Accreditation types:** GoLite, GoStandard, GoGlobal.
- **Known mandatory documents:**
  - Certificate from the **Nigerian Civil Aviation Authority** (AE and HE location types)
  - Certificate of incorporation
  - Passport or ID for each shareholder or owner
  - Bank statement verifying the account name and number
  - Direct debit account details
- **Not stated on the page:** minimum capital, security deposit, bank guarantee amount, staff qualifications.
- **[BLOCKER]** We do not currently hold an NCAA certificate or IATA accreditation. Obtaining both is a regulatory dependency with an unknown timeline, so I have not assumed either.

### Consolidator or supplier-accredited route (recommended for launch)

- Duffel's Managed Content ticketing (see section 1) lets us sell and ticket under Duffel's accreditation, which avoids needing our own IATA accreditation at launch.
- **Open:** Confirm with Duffel that Nigerian-based sellers can use Managed Content, and what contractual obligations apply (refunds, dispute handling, chargebacks, and who holds the customer relationship for ticketing liability).
- **Rule for the product:** Until a ticket number is returned by the supplier, a booking is shown as **reservation pending** or **awaiting ticketing**, never as a confirmed ticket. See the architecture doc for the status model.

## 4. Legal and compliance

- **Nigeria Data Protection Act 2023:** appoint or confirm a data protection officer, publish a privacy notice, and check whether sending passenger data to Duffel (or to hosting outside Nigeria) is a cross-border transfer requiring safeguards. Needs legal advice.
- **Consumer terms and ticketing rules:** refund, change, and airline fare-rule disclosures. Needs legal review, especially for international departures.
- **Tax:** VAT and any service fees charged in Nigeria, and the treatment of FX conversion. Needs an accountant.
- **Financial services:** confirm whether any part of holding or settling customer funds triggers CBN licensing. Assume it does until a lawyer confirms otherwise.

## 5. Infrastructure

- **Supabase:** choose a plan and region. Confirm which regions are available and how close they are to our customers and the supplier APIs, since latency affects search.
- **Vercel:** confirm hosting plan and whether a Nigerian-based company can use it commercially.

## 6. Launch-blocking summary

| # | Dependency | Status | Owner action |
|---|---|---|---|
| 1 | Duffel commercial agreement and Nigerian eligibility | Not started | Sales call, documents |
| 2 | Duffel ticketing scope for Nigerian origin and international departures | Not started | Written confirmation |
| 3 | Payment provider approval (Paystack or Flutterwave) | Not started | Apply with CAC and tax documents |
| 4 | IATA accreditation or consolidator agreement for own ticketing | Not started, regulatory | Legal and NCAA route, long lead time |
| 5 | Amadeus / Sabre availability | Unverified | Contact sales (only if Duffel fails) |
| 6 | Stripe merchant eligibility | Unverified | Contact Stripe |
| 7 | NDPA compliance and legal review | Not started | Lawyer |
| 8 | Crypto payment regulatory review | Not started | Lawyer, separate spec |

## 7. Development without approvals

Work that does **not** depend on any of the above and can proceed now:

- Project scaffold (Next.js, TypeScript)
- Supabase schema, RLS policies, and role model
- Provider interfaces with a **mock flight supplier** and a **sandbox-only payment adapter**
- Booking status model that keeps reservation and ticket status separate
- Audit logging and environment separation

Production adapters for any provider stay disabled until its row in the table above is marked **Confirmed** and the approval is recorded in this document.

## 8. Register update (12 Nov 2026)

New or changed outstanding dependencies after the owner's decisions:

| # | Dependency | Status | Owner action |
|---|---|---|---|
| D1 | Paystack authorisation and capture (pre-auth) for Nigerian merchants, NGN cards | **Unconfirmed.** Documented for South African merchants, ZAR only | Written confirmation from Paystack |
| D2 | Flutterwave authorisation and capture for Nigerian merchants | Unverified | Written confirmation from Flutterwave |
| D3 | Duffel balance funding and minimum balance (needed for supplier-paid ticketing, Option B and the ticketing step in Option A) | Not explained on Duffel's payments page | Duffel sales (enquiry section 7) |
| D4 | Duffel hold coverage by airline and route, and price guarantee rules | Partly documented: only American Airlines and Duffel Airways confirmed by name | Duffel sales |
| D5 | Whether a hold guarantees ticketing | Not stated; Duffel says documents appear only after payment | Duffel sales |
| D6 | Duffel coverage of Nigerian domestic airlines and international carriers serving Lagos and Abuja | Unknown | Duffel sales |
| D7 | Route and schedule data licence (OAG or Cirium) | Not purchased; needs owner approval | Owner decision |
| D8 | Transactional email provider (Postmark recommended), DPA, data-residency check | Recommendation only; nothing purchased | Owner approval |
| D9 | Error monitoring (Sentry recommended), DPA, data-residency check | Recommendation only; nothing purchased | Owner approval |
| D10 | Trademark clearance on the product name ("GO" is a working title) | Not started | Qualified Nigerian counsel |
| D11 | Two neutral colours outside the brand palette (`#FFFFFF`, `#1B3749`) | Owner to confirm | Owner |
