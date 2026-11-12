# Legal review register

Status: **No Nigerian legal counsel has been appointed. No legal approval has been obtained for anything in this platform.** This register lists the matters that qualified Nigerian counsel must review before production launch. Nothing in it is legal advice.

Owner's instruction (12 Nov 2026): appoint qualified Nigerian counsel before production launch. Until then, no production customer data is collected and no production payment or ticketing is enabled.

**How to read this register:** the matter is what needs review. The "law to check" column names the instrument we believe is relevant, so counsel can confirm it. Counsel must confirm every statute reference, its current version and its application to us. None of these references has been checked against current law by a lawyer.

---

## Counsel appointment

| Item | Status |
|---|---|
| Nigerian counsel appointed | **No.** Not yet identified |
| Named contact | **None.** Do not record a contact until the owner appoints one |
| Scope agreed in writing | No |
| Engagement letter and fee | No. Requires owner approval |

---

## 1. Data protection

| # | Matter | Why it matters | Law to check (counsel to confirm) | Status |
|---|---|---|---|---|
| 1.1 | Registration or notification with the data protection regulator, and the data controller and processor roles for each party | We collect names, dates of birth, nationality, contact details and, later, travel document numbers | Nigeria Data Protection Act 2023; regulator's general application and compliance guidance | Not started |
| 1.2 | Lawful basis for each processing activity (booking, marketing, analytics, fraud prevention) | Each activity needs a documented basis | NDPA 2023 | Not started |
| 1.3 | Privacy notice, in plain language, before collection | Customers must know what is collected and why | NDPA 2023 | Not started |
| 1.4 | Data processing agreements with the flight supplier, payment providers, email and monitoring vendors, and hosting | Required before personal data reaches them | NDPA 2023 | Not started |
| 1.5 | Cross-border transfers: Supabase and hosting regions, email and error tools, the flight supplier (based in the UK per its registered office), and passenger data sent to airlines and destination countries | Transfers abroad need safeguards and records | NDPA 2023 transfer provisions; check whether UK GDPR applies to UK-resident customers | Not started |
| 1.6 | Retention schedule for bookings, passenger details, payment records, logs and support notes | Some records are needed for tax and disputes, others must be deleted | NDPA 2023; tax and consumer-law retention periods | Not started |
| 1.7 | Passenger travel documents (passport numbers): whether and how to store them | Airlines need them for ticketing; the data is sensitive | NDPA 2023 (sensitive data rules); counsel to advise on necessity | Not started |
| 1.8 | Data subject requests: access, correction, deletion, objection | Customers have rights; we need a process within the legal deadline | NDPA 2023 | Not started |
| 1.9 | Breach notification to the regulator and to customers | Timelines are short and must be planned now | NDPA 2023 | Not started |
| 1.10 | Data protection officer: whether one must be appointed | Depends on scale and type of processing | NDPA 2023 | Not started |
| 1.11 | Marketing consent and unsubscribe rules | Email marketing needs consent and an opt-out | NDPA 2023; email marketing rules | Not started |

---

## 2. Consumer protection

| # | Matter | Why it matters | Law to check (counsel to confirm) | Status |
|---|---|---|---|---|
| 2.1 | Pricing transparency: whether displayed prices include taxes, fees and charges, and how we show them | Hidden charges are a common enforcement area | Federal Competition and Consumer Protection Act 2018; consumer protection regulator guidance | Not started |
| 2.2 | Refund and cancellation policy: our own rules and how they relate to airline fare rules | Refunds must be fair and consistent with fare rules | FCCPA 2018; airline ticketing rules (see 4) | Not started |
| 2.3 | Complaints handling and escalation path | Required for trust and for regulator complaints | FCCPA 2018 | Not started |
| 2.4 | Accessibility of key terms and disclosures | Customers must be able to read and understand terms | FCCPA 2018 | Not started |
| 2.5 | Advertising claims: "premium", "best price", "guaranteed" and similar wording | Claims must be substantiated | FCCPA 2018; advertising standards rules | Not started |
| 2.6 | Dispute resolution and the chargeback process | Customers must know their rights and routes | FCCPA 2018; payment scheme rules | Not started |

---

## 3. Terms and conditions

| # | Matter | Why it matters | Law to check | Status |
|---|---|---|---|---|
| 3.1 | Customer terms of use and sale: our role (agent, seller of record, or merchant of record), liability limits, and governing law | Defines who the customer contracts with | Contract law; Nigerian consumer law (see 2) | Not started |
| 3.2 | Booking terms that reflect our fulfilment policy (`docs/06`): authorisation, capture, release and failed-ticket handling | Customers must understand that money is held before tickets are issued | Contract law; payment provider terms | Not started |
| 3.3 | Terms for holds and price guarantees, including what happens when a guarantee expires | Price changes must be disclosed before payment | Consumer protection and contract law | Not started |
| 3.4 | Terms for passenger responsibilities: name matching, documents, visas and passport validity | Ticket errors cause denied boarding; customers must be warned | Destination country rules; airline conditions of carriage | Not started |
| 3.5 | Privacy notice and cookie notice | Required before collection (see 1.3) | NDPA 2023 | Not started |
| 3.6 | Acceptable use and fraud terms for accounts and payments | Protects the platform | Contract law; payment rules | Not started |
| 3.7 | Business-customer (corporate) terms, if offered later | Different legal and tax treatment | Contract law; tax | Not started |

---

## 4. Air travel and ticketing

| # | Matter | Why it matters | Law to check | Status |
|---|---|---|---|---|
| 4.1 | Whether we are permitted to sell and issue tickets through a supplier's accreditation (Duffel Managed Content), and any Nigerian licence needed | This is core to the business model | Nigerian Civil Aviation Authority requirements; IATA accreditation rules (the IATA page lists a Nigerian NCAA certificate as mandatory for agencies) | Not started; supplier confirmation needed first |
| 4.2 | Whether a travel agency or ticket seller licence is required for our activity in Nigeria | Operating without one is an enforcement risk | NCAA rules; Nigerian aviation regulations | Not started |
| 4.3 | Responsibility for refunds from airlines when the airline cancels | Customers expect a refund; the airline owes it | Air passenger rights (Nigerian and destination country rules); conditions of carriage | Not started |
| 4.4 | Airline schedule-change notices, and our duty to pass them on | Missing a notice causes missed flights | Consumer protection; airline rules | Not started |
| 4.5 | Passenger data to airlines and government advance passenger information systems | Airlines and some countries require passenger data in advance | Destination country requirements; NDPA 2023 | Not started |

---

## 5. Payments and payment licensing

| # | Matter | Why it matters | Law to check | Status |
|---|---|---|---|---|
| 5.1 | Whether our flow (authorisation, holding funds, capture, refunds, settlement via a third party) requires a licence or is covered by the provider's licence | Holding or moving customer money can be a regulated activity | Central Bank of Nigeria rules on payment service providers and payment services | Not started |
| 5.2 | The merchant agreement with the chosen provider (Paystack, Option A): authorisation and capture terms, settlement, chargebacks and fees | Terms determine what we can actually offer | Provider's contract; CBN rules | Not started; provider confirmation needed first |
| 5.3 | Foreign exchange: converting NGN and foreign-currency prices, and FX fees charged to customers | FX rules apply to conversion and to settlement abroad | CBN foreign exchange rules | Not started |
| 5.4 | Anti-money laundering and know-your-customer obligations for payments and high-value bookings | Obligations apply to payment and financial businesses | Money laundering prevention law (counsel to confirm the current act); CBN AML guidance | Not started |
| 5.5 | Tax on fees and service charges, and VAT on airline tickets and our service | Affects prices and invoicing | Federal Inland Revenue Service and VAT rules | Not started |
| 5.6 | Recording and invoicing rules for receipts | Customers and tax authorities need valid receipts | Tax law | Not started |

---

## 6. Cryptocurrency payments

| # | Matter | Why it matters | Law to check | Status |
|---|---|---|---|---|
| 6.1 | Whether accepting cryptocurrency for flight bookings is lawful in Nigeria, and under which regulator | The position on crypto in Nigeria has changed and must be confirmed | CBN directives on virtual assets; Securities and Exchange Commission rules on digital assets (counsel to confirm the current position) | Not started; **no crypto is built or enabled** |
| 6.2 | Who holds and converts the crypto, and whether that makes us a regulated virtual asset business | Holding or converting crypto for customers can be regulated | As above | Not started |
| 6.3 | Tax on crypto transactions and on conversions | Affects price and records | Tax law | Not started |
| 6.4 | Fraud, sanctions and AML screening for crypto payers | Crypto payments carry particular risk | AML law (see 5.4); sanctions rules | Not started |
| 6.5 | Consumer disclosures for crypto price volatility and refunds in crypto | Customers must understand the risk | Consumer protection (see 2) | Not started |

---

## 7. Trademarks and brand

| # | Matter | Why it matters | Law to check | Status |
|---|---|---|---|---|
| 7.1 | Trademark clearance search for the final product name in Nigeria | "GO" is a common word and likely not registrable on its own | Trademarks Act; Trademarks Registry practice (counsel to confirm) | Not started |
| 7.2 | Similarity search for the logo, including concepts A and B in `docs/09` | Concept A resembles a major search brand's G; concept B uses a common motif | Trademarks Act | Not started |
| 7.3 | Trademark filing in Nigeria, and in the countries we plan to launch in | Protects the name and mark before launch | Trademarks Act; foreign filing rules | Not started |
| 7.4 | Use of airline and supplier names and logos on our site | Use of third-party marks needs permission or must be factual only | Trademarks Act; supplier brand guidelines | Not started |
| 7.5 | Domain names and social handles | Must match the trademark strategy | Trademark and domain dispute rules | Not started |

---

## 8. Corporate and operational

| # | Matter | Why it matters | Law to check | Status |
|---|---|---|---|---|
| 8.1 | Company structure: who is the contracting entity and merchant of record, and the company's registered objects (CAC) | The business must be authorised to do what it does | Companies and Allied Matters Act; CAC registration | Not started |
| 8.2 | Employment and contractor agreements for support and engineering staff | Standard, but needed before hiring | Labour law | Not started |
| 8.3 | Insurance (professional indemnity, cyber) | Protects against claims from ticketing errors and data breaches | Insurance market rules | Not started; **not recommended to buy without owner approval** |

---

## Summary of matters needing counsel before production launch

Priority items, which block launch:
1. Data protection: 1.1, 1.3, 1.4, 1.5, 1.7, 1.9
2. Consumer terms: 2.1, 2.2, 3.1, 3.2, 3.3
3. Air ticketing authority: 4.1, 4.2, 4.3
4. Payments licensing and merchant terms: 5.1, 5.2
5. Trademarks: 7.1, 7.2 (before any public use of the name or logo)
6. Crypto: 6.1 must be resolved before any crypto work begins

Crypto matters (section 6) block the crypto feature only. They do not block the fiat launch.
