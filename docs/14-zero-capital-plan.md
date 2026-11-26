# 14. Zero-capital commercial and technical plan

Date: 13 Nov 2026
Status: research and plan only. No paid service, supplier deposit, live transaction or production activation has been enabled. No code, payment or ticketing path has been changed. No counsel appointed, no financial commitment made.

Owner constraint (12 Nov 2026): GO has no capital. Do not assume pre-funding of any supplier balance, subscription, or coverage of failed captures. Do not weaken payment security. Keep paid services, deposits, live transactions and production activations disabled.

## 1. Bottom line

On the terms verified so far, GO cannot issue its own flight tickets with zero capital.

- Duffel, the supplier the code is built around, requires a pre-funded Duffel Balance before an order can be created or paid. Card payment for flight orders was removed. No credit line, invoice or postpaid option is described.
- Under the rule in docs/06 (never take money before a booking can be fulfilled), GO must hold a balance at least equal to the fare it is about to ticket before it accepts a customer's payment. That is a capital requirement, however small.
- The zero-capital routes that remain are commission and agency models, in which GO does not carry the ticketing cost. Each one needs an agreement or an eligibility check that has not yet been completed.

## 2. Verified facts

| Topic | Finding | Source |
|---|---|---|
| Duffel pricing | Pay-as-you-go, with "no up-front costs or monthly commitments". Per-booking fees, platform fee, sandbox cost and minimum balance are not stated. | Duffel help, "How does pricing work" article (read 13 Nov 2026) |
| Duffel Balance for orders | "You won't be able to create your order until you top up." | Duffel help, "What happens if I don't have enough money in my Duffel Balance to book" article (read 13 Nov 2026) |
| Duffel payment methods | Card: "requires approval to access"; card amounts must match the supplier quote, and GO stays liable for chargebacks and fraud. Duffel Balance: "You must pre-fund it, which ties up capital." ARC/BSP cash: only for customers with their own ARC or IATA accreditation. Credit lines, invoices, postpaid and airline credits are not mentioned. | [Duffel collecting payments](https://duffel.com/guides/collecting-payments-from-your-customers) |
| Card payment for flight orders | Removed in 2019 ("For now, we've removed the card payment method"). No return date given. | [Duffel changelog, 29 Apr 2019](https://changelog.duffel.com/announcements/weve-temporarily-removed-the-ability-to-pay-by-card-replacing-it-with-paying-using-a-duffel-balance) |
| Hold orders | Offers are holdable only if `requires_instant_payment` is `false`. Pay later from the balance with `type: balance`. Price guarantee is set per order and may be `null`. There is no credit facility. If payment misses `payment_required_by`, the space is released. | [Duffel holding orders](https://duffel.com/docs/guides/holding-orders-and-paying-later) |
| Amadeus | Press reported a Self-Service portal shutdown (Feb 2026). Amadeus's own statement says only that its **Enterprise** portal and APIs "remain fully available" and names no Self-Service shutdown. Self-Service status is **unresolved** and must not be relied on. | [Amadeus statement](https://amadeus.com/en/industry-messaging/statement-regarding-amadeus-for-developers-portal); press reports in search results only |
| IATA accreditation, Nigeria (travel agent) | Visible checklist items: NCAA certificate, certificate of incorporation, company registration certificate, bank statement, shareholder IDs, direct debit account details and mandate. Financial security amounts, minimum capital and fees are **not stated** on the checklist. Pages 2 and 3 were not read. | [IATA country requirements, Nigeria](https://www.iata.org/en/services/travel-agency-program/accreditation-travel/country-requirements/a521r0000004mctaae/pax/) |
| Travelpayouts (Aviasales) | Revenue share of 40%, "on average, you will receive 1.1% of the ticket price", on an average ticket of $353 (figures from the page). Paid monthly, 10th to 20th. "Only confirmed bookings will be paid." Payout currency, minimum payout, KYC, business registration and Nigeria eligibility are **not stated**. | [Aviasales affiliate program](https://travelpayouts.com/en/offers/aviasales-affiliate-program) |

## 3. Routes to ticketing cost, assessed

For each route: cost to GO, what is required, status.

### Route A. Duffel with a pre-funded balance (current code path)
- **Capital:** at least one fare in the balance before any booking can be paid. More for volume, plus a reserve for refunds and price changes.
- **Zero-capital status:** not available on verified terms.
- **Open question (test in sandbox, free if confirmed):** whether a *hold* order can be created with an empty balance. Duffel's text says "create your order", which may cover holds too. Not verified. Even if true, paying the hold still needs the balance before `payment_required_by`.
- **Action:** ask Duffel directly, in writing, whether it offers credit, postpaid settlement or a deferred invoice for an early-stage travel business. Do not assume yes.

### Route B. Commission or referral (no ticketing by GO)
- **Capital:** none for GO. The partner ticket, and the partner's cost, sit with the partner.
- **Revenue:** commission share. Travelpayouts shows 1.1% average of ticket value at the stated sample, unverified for Nigeria and unverified in payout terms.
- **Status:** eligibility unverified. Could support a launch of search and comparison, but it changes the product from a booking platform to a referral platform. The owner must decide whether that is acceptable.
- **Constraint:** GO would not take payment, so the money-safety rules are not engaged. It must not present a referred booking as a GO booking.

### Route C. Agency partnership (sub-agent under an accredited Nigerian agency)
- **Capital:** the partner's accreditation and settlement funding carry the ticketing cost. GO would need a revenue-share agreement.
- **Status:** not verified. No Nigerian agency has been identified or contacted. Needs counsel review (docs/11) before any agreement is signed.
- **Risk:** the partner controls issuance and refunds. GO's fulfilment and refund commitments then depend on the partner's process, which must be written into the agreement.

### Route D. Own IATA accreditation (BSP) or ARC
- **Capital:** unknown. Financial security and fees are not stated on the visible checklist. The application guide and pages 2–3 must be read.
- **Status:** not zero-capital on current evidence. Long lead time. Requires incorporation, NCAA certificate and bank documents.

### Route E. Duffel ARC/BSP cash
- Only for customers who hold their own ARC or IATA accreditation. Does not help a consumer platform.

## 4. Revenue model, operating cost and minimum funding

### Revenue (not yet quantified)
- Route B: commission share on confirmed bookings only. Rate and payout terms unverified.
- Route C: revenue share set by agreement. Not verified.
- Route A (once funded): service fee per booking. Fee policy is currently a zero placeholder (UNDECIDED_FEE_POLICY). Owner must decide the fee. No figure has been chosen.

### Operating costs (to verify, not estimated)
- Domain, hosting, database and email: free tiers may exist. Not verified for the chosen providers, and not enabled.
- Company registration, NCAA certificate, IATA accreditation, legal counsel, trademark search: fees not yet obtained. Counsel quotes are all "request quote" (docs/11).
- Payment providers: Paystack and Flutterwave merchant activation fees and settlement terms are not verified. NGN pre-authorisation is not confirmed for either (docs/12).

### Minimum genuinely required funding
Cannot be given as a number yet. Under Route A it equals:

> (highest fare GO will accept at one time) + (refund and price-change reserve) + (any non-zero fixed monthly operating cost)

The first term needs a fare sample and a volume plan from the owner. Route A also needs a currency decision: Duffel balances are funded in a supplier currency, and Nigerian customer payments settle in NGN. The FX conversion route and its cost are not verified.

## 5. What can be built for free

These need no money and no commercial agreement:

- Search, booking and reservation code, using the mock supplier and local fixtures (already built, tests pass).
- Fulfilment and payment state machines, webhook verification, and failure tables (already built, fixture-tested).
- Booking-summary, travel-document validation and masking logic (already built).
- Brand tokens, logo, colour contrast checks (done, pending owner approval for derived dark shades).
- Counsel shortlist and scope of work (done, no counsel appointed).
- Documentation of verified and unverified provider facts (docs 06, 09, 11, 12, 13, 14).
- Duffel sandbox use, **only after Duffel confirms in writing that sandbox access is free**. Not yet confirmed.

Blocked for a different reason: package installs are disabled, so the Next.js UI and production build cannot be made until network settings allow installs. This is a restriction, not a cost.

## 6. What needs money or an agreement

- Any supplier balance (Duffel or otherwise): **money**.
- Production payments on Paystack or Flutterwave: merchant activation **may cost money**; NGN pre-authorisation is not confirmed.
- Counsel review and trademark search: **money**, requires owner approval.
- Company registration, NCAA certificate, IATA accreditation: **money and time**.
- Commission or agency routes: **agreement**, requires counsel review and a signed partner.
- Duffel credit or postpaid terms, if they exist: **agreement**, not offered publicly.

## 7. Recommended sequence (for owner decision, nothing started)

1. **Confirm in writing** with Duffel: (a) whether credit or postpaid settlement exists for an early-stage business; (b) whether sandbox access is free; (c) whether a hold order can be created with an empty balance. Answers decide whether Route A is zero-capital at all.
2. **Check Travelpayouts eligibility** for Nigeria, the payout currency and minimum, and KYC requirements, before relying on Route B.
3. **Identify one or two Nigerian accredited agencies** willing to discuss a sub-agent or revenue-share arrangement (Route C). Do not contact them until the owner approves outreach.
4. **Keep building** the free items in section 5 without enabling any live service.
5. **Revisit funding** only after the answers in steps 1–3 exist, and then size the minimum float from real fare data.

## 8. Decisions for the owner

- [ ] Accept that GO cannot be zero-capital on its own ticketing (Route A) unless Duffel offers credit.
- [ ] Choose a launch route to test first: B (referral), C (agency partnership), or wait for A.
- [ ] Approve or refuse outreach to Duffel, Travelpayouts and agencies.
- [ ] Set a fee policy (currently zero placeholder).
- [ ] Approve counsel quote requests (docs/11), if any spending is acceptable. Currently zero.

## 9. Unverified items (do not treat as facts)

- Duffel credit, postpaid or invoice terms: not found.
- Duffel sandbox cost; Duffel per-booking fee; Duffel minimum balance.
- Whether a hold order can be created with an empty Duffel balance.
- Amadeus Self-Service status (press reported shutdown; Amadeus statement addresses only Enterprise).
- IATA Nigeria financial security amounts, fees and BSP settlement terms (pages 2–3 and the application guide not read).
- Travelpayouts payout currency, minimum, KYC and Nigeria eligibility.
- Paystack and Flutterwave NGN pre-authorisation and merchant fees.
- Any free-tier limits for hosting, database or email providers.

## Update: 26 Nov 2026

Route A (Duffel pre-funded balance, GO-funded) is **withdrawn** under `24` D3 option (c). GO does not fund supplier balances. A route is usable only if an authorised partner carries the funding under an approved agreement. Until a partner is approved, real customer bookings stay disabled.
