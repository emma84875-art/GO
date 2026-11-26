# 24. Phase 19.0 decision record: booking, payment and fulfilment

Status: **Approved by the owner, 26 November 2026 (04:44 local time).** Documentation only. No application code was changed. Phase 19.1 is **not** approved and has not started.
Decided by: project owner (written approval and resolution of D3, 26 November 2026).
Supersedes: the open payment and fulfilment questions in `04` section 13, and the Option A/B/C position in `06` and the funding assumptions in `12`, `13` and `14` where they differ (see section 6).
Related: `04` (implementation plan, roadmap in its section 16), `06` (booking, payment and fulfilment policy), `12` (payment architecture), `13` (fulfilment), `14` (zero-capital plan), `18` (security audit).

---

## 1. Purpose

This record fixes the business and money-safety decisions that govern booking, payment and ticket fulfilment for GO. Every later phase must conform to it. Where a decision cannot yet be implemented because an external dependency is missing, the dependency is listed in section 4 and the affected capability stays disabled.

## 2. Decisions

### D1. Payment model: Option A only

**Decision.** GO uses one payment model. The customer's payment is **authorised** (held, not taken). The ticket is issued by the authorised partner and independently verified by GO. Only then is the authorised payment **captured**.

**Not approved.**
- Capture-now (taking the customer's money at booking, before ticketing) is not approved as an alternative in any form.
- Option B (GO-funded supplier balance, supplier-first) is not approved.
- Option C (customer pays first, then GO tickets) is excluded.

**Implication.** Any code path that captures before verification, or that pays a supplier from GO funds, is a defect and must fail the money-safety tests.

### D2. Payment providers: investigation only

**Decision.**
- Paystack is the first provider to investigate.
- Flutterwave is the alternative to investigate if Paystack does not qualify.
- Neither provider is approved for production until all of the following are verified in writing by the provider:
  1. card authorisation (hold) for Nigerian merchants;
  2. later capture of the held amount, including partial capture and full release;
  3. authorisation expiry behaviour and window;
  4. currency support for NGN cards;
  5. eligibility of a travel business for Nigerian merchant accounts, including any IATA or documentation requirement.

**Fallback.** If no suitable provider supports the required flow, payments and real customer bookings remain disabled. GO does not switch to capture-now or to a GO-funded supplier balance to fill the gap.

**Implication.** No provider enquiry is sent without owner approval (see D6). Phase 4 (payments in test mode) may use a provider's test environment only after written owner approval of the specific provider.

### D3. Supplier funding and financial exposure: resolved as option (c)

**Decision (owner, 26 November 2026).** GO will use only a supplier or authorised consolidator partnership that can **carry the supplier funding** required for ticket issuance, without GO providing working capital, prefunding, unsecured credit or assuming airline payment exposure.

**Standing rules.**
- Customer authorisation does **not** give GO permission to pay supplier costs from its own funds.
- GO-funded supplier exposure is strictly zero. There is no GO-funded supplier balance, no airline prepayment from GO's own money, no unlimited supplier balance, no unsecured credit and no supplier prefunding.
- If no partner supports this arrangement, real customer bookings remain disabled.
- No fallback is to be implemented that exposes GO to supplier funding risk.

**Consequence for existing architecture.** The following are withdrawn:
- The Duffel balance route ("Route A" in `14`, GO topping up a Duffel balance before paying orders).
- Any step in which GO pays the supplier from its own balance before capture (`13`, orchestrator step 4, and `06` step 6 "supplier paid from our balance").
- Decision 4 in `13` (approve company funding of the Duffel balance).

### D4. Supplier and ticketing partner: required before any real booking

**Decision.**
- GO currently has no confirmed supplier, ticketing consolidator or IATA accreditation.
- A real customer booking requires an authorised partner that meets D3. Until one is identified, approved and confirmed in writing, real bookings are disabled.
- The architecture supports an authorised consolidator or agency partner as the party that issues tickets and carries supplier funding.
- Duffel, or any other supplier, must not be assumed able to issue tickets for GO, or to fund them, until its commercial and technical capability is confirmed in writing.
- No supplier application, partner application, contract, deposit or commercial commitment is authorised by this record.

**Implication.** The ticketing interface is designed around a partner role (`issueTicket` through an authorised party, with partner-carried funding). Duffel's sandbox may be used for search and order-shape testing only, and only once access is approved.

### D5. Currency policy: NGN for payment; original currency preserved

**Decision.**
- NGN is the initial customer payment currency.
- Original supplier currency and amount are preserved and displayed.
- Until an approved FX source, rate-lock mechanism and customer pricing policy exist, **foreign-currency offers must not proceed to customer payment or ticketing.**
- No exchange rate is invented. No price is silently converted.

**Implication.** Search may show offers in their original currency (implemented in Phase 18.7). Checkout must refuse any offer not priced in NGN until the FX dependency is closed. A USD or GBP fare can be viewed but not booked, and the customer must be told so clearly.

### D6. Passenger information and privacy

**Decision.**
- Collect the minimum personal information needed to ticket a booking.
- Any stored passenger personal data uses the approved encryption architecture.
- Date of birth, nationality and ticket numbers must be encrypted if stored.
- Passport collection remains disabled until legal and operational requirements are established (counsel and data-protection review).
- Privacy-first access controls, audit logging, and defined retention and deletion policies apply.

**Implication.** No passenger document data is collected or stored in Phase 19.1. Where a partner requires a passport field, the booking stays disabled for that route until D6's conditions are met.

### D7. Ticketing and fulfilment separation

**Decision.** Four stages are separate and recorded separately:
1. **Reservation** (a supplier hold or an offer that is still valid);
2. **Supplier or partner order** (the order exists with the party that will ticket it);
3. **Ticket issuance** (the partner issues ticket documents, funded under D3);
4. **Ticket verification** (GO independently checks the documents).

A customer booking must not be marked **confirmed** until the ticket documents have been verified against the passenger names, the itinerary and the supplier booking reference, and the payment conditions (D1, D3) have been satisfied.

**Implication.** The current status vocabularies (five, not yet reconciled, per the Booking Operations audit) must be reduced to one customer-facing model before Phase 19.1. This is an implementation task, not a decision that changes behaviour.

## 3. Approved operational sequence

This is the only permitted sequence for a customer booking.

1. The customer submits a booking.
2. GO validates passenger and itinerary information and revalidates the fare.
3. The customer's payment is **authorised** (held, not captured).
4. The authorised supplier or consolidator carries the funding and completes ticket issuance under an approved commercial arrangement.
5. GO independently verifies the issued tickets (names, itinerary, supplier booking reference).
6. GO **captures** the customer's authorised payment.
7. GO settles the agreed amount with the partner according to the approved commercial terms.
8. GO confirms the booking to the customer.

**Failure rules.**
- If step 4 fails, the authorisation is released. Nothing is captured and GO pays nothing.
- If step 5 fails, the authorisation is released. Nothing is captured.
- If step 6 fails after verification, the case is a critical incident. It is escalated at once and must be visible on the admin dashboard. GO does not pay the partner from its own funds to close the gap.
- Step 7 happens only after step 6 is complete. GO never settles with the partner before the customer's payment has been captured.

## 4. Implementation restrictions in force

Until the owner approves Phase 19.1 in writing:

- No live payments.
- No ticket issuance.
- No customer data collection beyond what the existing phases already hold.
- No production supplier calls.
- No introduction of paid services, GO-funded supplier balances or commercial commitments.
- No supplier applications, partner applications, provider enquiries, contracts or deposits.
- No application code changes under Phase 19.0.

## 5. Unresolved external dependencies

| # | Dependency | Blocks | Owner action needed |
|---|---|---|---|
| E1 | Written confirmation from a payment provider of NGN card authorisation and later capture | Any card payment in production (D1, D2) | Approve a provider enquiry |
| E2 | ~~Whether authorisation counts as "secured"~~ **Resolved: option (c), 26 Nov 2026** | Closed | None |
| E3 | Authorised ticketing partner or consolidator that carries supplier funding (D3, D4), with written capability and commercial terms, including settlement terms for step 7 | **All real customer bookings** (D4) | Identify and approve a partner |
| E4 | Approved FX source, rate-lock mechanism and customer pricing policy | Any foreign-currency booking (D5) | Approve an FX approach |
| E5 | Nigerian counsel on data protection, passenger data, refunds and payment licensing | Passenger data collection, passport handling, launch (D6) | Appoint counsel |
| E6 | Confirmed Nigerian merchant eligibility and IATA or documentation requirements for travel payments | Provider go-live (D2) | Provider response |
| E7 | Historical currency status and exponent checks recorded in `23` section 16 | Accuracy of legacy currency handling (not a booking blocker) | Verify against an ISO historical source |

## 6. Architecture that follows this decision

These are requirements on later phases. Nothing here is implemented in Phase 19.0.

- **Payment.** Capture is allowed only after the partner's tickets are issued and GO has verified them. The existing capture gate (supplier fulfilment confirmed, amount matches, window open) stays, and its "supplier fulfilment" means verified partner issuance. (`12`)
- **Supplier funding.** The orchestrator's step "pay the supplier from our balance" (`13`, step 4) is replaced by partner-funded issuance under an approved agreement. No code path may pay a supplier from GO funds. A partner whose terms require GO prefunding is not usable. (`13`)
- **Settlement.** A new step settles the partner after capture (sequence step 7). It is recorded, reconciled and gated on capture. (`13`, `12`)
- **Zero-capital plan.** Route A (Duffel pre-funded balance) is withdrawn. Route A may be reconsidered only if its funding sits with a partner under D3. (`14`)
- **Partner interface.** The ticketing interface targets a partner role, not Duffel. Duffel's order operations remain unbuilt and are not a dependency of Phase 19.1.
- **Existing code conflicts.** The fulfilment orchestrator's supplier "pay once" step and the Duffel order-operations design assume GO-funded payment. They are fixture-only and not connected to any route, so nothing is live. They must be replaced before any supplier path is enabled. This is recorded as a defect to fix in Phase 19.2 and is a blocker for enabling any supplier.

## 7. Approval

| Item | Decision | Approved by | Date |
|---|---|---|---|
| D1 Option A only | Approved | Owner | 26 Nov 2026 |
| D2 Paystack first, Flutterwave alternative, neither approved for production | Approved | Owner | 26 Nov 2026 |
| D3 Option (c): partner carries supplier funding; GO-funded exposure zero | **Approved (resolution of E2)** | Owner | 26 Nov 2026, 04:44 |
| D4 No confirmed supplier or partner; partner required for real bookings | Approved | Owner | 26 Nov 2026 |
| D5 NGN payment currency; no conversion | Approved | Owner | 26 Nov 2026 |
| D6 Passenger data minimisation and encryption | Approved | Owner | 26 Nov 2026 |
| D7 Stage separation and verification before confirmation | Approved | Owner | 26 Nov 2026 |
| Section 3 operational sequence | Approved | Owner | 26 Nov 2026, 04:44 |

Approval of Phase 19.1 is a separate written decision and is **not** given by this record.
