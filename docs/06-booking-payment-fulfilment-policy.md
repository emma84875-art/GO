# Booking, payment and fulfilment policy

Status: **Policy proposal for owner approval.** This is a binding design rule for the platform once approved. It sets the order of operations for every booking and every payment method.

## The rule

**We never take a customer's money before we know the flight can be ticketed.**

In practice:

1. Before any customer money moves, the supplier has confirmed the offer is still available and priced, and the customer's payment method has been authorised (held), not taken.
2. The ticket is issued.
3. Only after the supplier confirms the ticket was issued do we capture the money.
4. If ticketing fails at any step, the authorisation is released (or any amount taken is refunded automatically). The customer is never left charged for a booking that is not ticketed.

The booking system must enforce this in code, not rely on operators remembering it. Database and state-machine checks back it up (already started in `packages/core/src/booking-status.ts` and `supabase/migrations/20261112000000_initial_schema.sql`).

## Why holds are not enough

Duffel's documentation (fetched 2026-11-12) describes holding orders and paying later:

- A hold only reserves seat space until a payment deadline (`payment_required_by`).
- Holds are available only where the offer has `requires_instant_payment` set to `false`. Duffel says this must be checked per offer, and that holding "is not yet available for all airlines". The guide confirms only American Airlines and Duffel Airways by name.
- A price guarantee exists only sometimes (`price_guarantee_expires_at`). Without it, the price can change before payment.
- A hold does **not** guarantee a ticket. Documents appear only after payment.

So a hold protects seat space and, sometimes, price. It does not prove ticketing will succeed. That is why authorisation and ticketing come before capture.

## Order of operations (target flow)

| Step | Action | Money moved? | If it fails |
|---|---|---|---|
| 1 | Search. Show prices in NGN with the FX rate and timestamp. | No | Show error, let customer retry |
| 2 | Quote: revalidate the offer with the supplier. Lock the price for a short window (for example 15 minutes). | No | Offer expired: return to search |
| 3 | Passenger details, validated against the supplier's rules. | No | Customer corrects details |
| 4 | Create a supplier **hold** where the offer allows it. Record the payment deadline and price guarantee. Where holds are unavailable, revalidate immediately before step 5. | No | Hold unavailable: go to step 5 with immediate revalidation. Hold failed: return to search |
| 5 | **Authorise** the customer's payment method for the total. Authorise only; do not capture. | Held, not taken | Customer's payment declined: release hold, booking stays unpaid |
| 6 | **Ticket**: pay the supplier and issue ticket(s), or confirm the instant-payment order issued tickets. Verify each passenger has a ticket number. | Supplier paid from our balance (funding arrangement not yet confirmed with Duffel) | Ticketing failed: **release the authorisation**, mark `ticketing_failed`, notify customer and support, no capture |
| 7 | **Capture** the authorised amount. | Taken | Capture failed after ticketing: treat as a critical incident (see below) |
| 8 | Send confirmation with ticket numbers and itinerary. | No | Retry notification; ticket remains valid |

Step 6 must run before step 7, always. A capture that happens before ticketing is confirmed is a defect.

## Where authorisation is not available

Authorisation (hold on the customer's card) is required for the rule above. It is **not confirmed** for Nigerian merchants:

- Paystack's card pre-authorisation documentation (fetched 2026-11-12) describes the feature for South African merchants only, with ZAR amounts. It does not mention Nigeria or NGN.
- Flutterwave: authorisation and capture for Nigerian merchants not yet verified.
- Duffel's balance payment type is documented, but how the balance is funded, and whether card payments on our side are supported, is not explained on the page.

Until one of these is confirmed in writing, the options are:

**Option A (preferred, needs confirmation):** Authorisation and capture from a provider that supports it for Nigerian NGN cards. Follows the flow above exactly.

**Option B (fallback, owner decision required):** Supplier-first fulfilment. We keep a funded Duffel balance (or equivalent) and ticket before charging the customer, then capture immediately. This means we fund supplier cost before collecting from the customer. It needs a funded balance arrangement, a working-capital decision and a rule for unpaid tickets, all of which need written confirmation from Duffel and your finance decision.

**Option C (not permitted):** Customer pays first, then we ticket. This violates the rule and is **not** part of this policy. It is not built, and it is not offered.

**Until Option A or B is confirmed, card and bank-transfer payment for production bookings stays disabled.** Search and quoting can run on the mock and sandbox.

## Failure handling

**Ticketing fails before capture:** release the authorisation (customer sees the hold reversed, usually within minutes per provider). Mark `ticketing_failed`. Offer the customer a search for alternatives or a notification to try again. No money taken.

**Ticketing succeeds but capture fails:** the tickets exist, the customer is not charged. Retry capture within the authorisation window. If capture cannot complete, support is alerted immediately and the ticket is either cancelled with the supplier (where fare rules allow) or the customer is contacted to pay. This case must be rare and must be visible on the admin dashboard within minutes.

**Supplier does not respond after payment:** a reconciliation job checks the supplier's order status. Nothing is captured until the supplier confirms tickets. Stuck orders are escalated after a defined time.

**Customer pays too late (hold expired):** the authorisation lapses and the booking returns to search. The system never captures an expired authorisation.

**Price changed between quote and payment:** the system re-prices at step 4 or 5. If the price rises, the customer must accept the new price before authorisation. The customer is never charged an amount they have not accepted.

## Refunds and cancellations

- Refund amounts follow the supplier's fare rules, returned on the order. Our own rules cannot override them.
- Refunds are issued through the original payment method wherever the provider allows it.
- Every refund and reversal is written to the audit log with the reason.

## Money safety invariants (to be tested)

1. No capture exists for a booking without a supplier-issued ticket number for every passenger.
2. No ticket is issued without a successful authorisation (or an approved Option B balance).
3. A ticketing failure never leaves an open capture.
4. Captured amount never exceeds the authorised amount.
5. Every money movement references a booking and a provider event ID (idempotency).
6. A booking marked `ticketed` cannot exist unless invariants 1 and 2 hold.

Invariants 1, 4 and 6 are partly enforced in the schema already. The rest go into the milestone 2 test suite before any payment provider is connected.

## Open questions for the providers

**Paystack (Nigeria):**
- Does Paystack offer card authorisation and later capture (pre-authorisation) to Nigerian-incorporated merchants, for NGN cards?
- What is the authorisation window, and what happens when it expires?
- Does capture support partial amounts and full release?
- Are travel businesses eligible, and what are the IATA and documentation requirements (earlier research: an IATA licence is required for travel agencies' international payments)?
- Settlement: which accounts, which schedule, which fees?

**Flutterwave (alternative):**
- The same authorisation and capture questions as Paystack.

**Duffel:**
- How is a balance funded, and what minimum balance is required?
- For Nigerian-origin routes, which airlines support holds, and what share of offers carry a price guarantee?
- After payment, how long until tickets are issued, and what error codes return when ticketing fails?
- If a payment fails after tickets are issued, what must we do to cancel, and who carries the cost?

## Ownership

- Policy approval: project owner.
- Payment-provider and fulfilment terms: confirmed in writing by each provider before activation.
- Legal review of customer-facing terms, refunds and authorisation wording: qualified Nigerian counsel.
