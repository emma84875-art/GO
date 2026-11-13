# Supplier booking and ticket fulfilment

Date: 13 Nov 2026
Status: **state machine, idempotency, money-safety link and customer screens-as-data are built and tested against a DEVELOPMENT FIXTURE. Duffel order operations are NOT implemented. Production ticketing is DISABLED.**

## What Duffel's documentation confirms (read 13 Nov 2026)

- **Hold orders:** `POST https://api.duffel.com/air/orders` with `type: "hold"` and no `payments`. Only offers with `payment_requirements.requires_instant_payment: false` can be held. Not all airlines support this.
- **Payment and ticketing:** tickets are issued when the order is paid, via `POST https://api.duffel.com/air/payments`. Paying with an outdated amount returns `price_changed`. A changed schedule returns `schedule_changed`.
- **Hold deadline:** if unpaid by `payment_required_by`, the airline releases the seats. The documentation does not say the order is cancelled automatically.
- **Price guarantee:** `price_guarantee_expires_at` may be null. If null, the price can change before payment.
- **Cancellation:** two steps. `POST https://api.duffel.com/air/order_cancellations`, then `POST .../{id}/actions/confirm`. Confirming cancels the order. The refund goes to our Duffel balance, so **we must refund the customer ourselves**. `refund_amount` may be null if the airline has not quoted it.

## Not confirmed (must be checked in sandbox before any use)

- The **create-order request schema** (`selected_offers`, passenger fields, `type`). The documentation page read was truncated before this section.
- Whether Duffel accepts an **Idempotency-Key** header. Not found. Idempotency is enforced on our side only.
- Whether tickets are returned in the create-order response. Not stated.
- Whether a hold order is cancelled automatically at its deadline.
- Any route restrictions beyond `requires_instant_payment`.

Because idempotency at Duffel is unconfirmed, an unclear order-creation outcome **locks the booking** for reconciliation. The system never re-sends it.

## Architecture (packages/fulfilment, plus order operations in packages/flights)

- `flights/src/supplier.ts`: optional `FlightOrderOperations` (createOrder, getOrder, payOrder, cancelOrder). Adapters implement only what they support.
- `fulfilment/src/status.ts`: states and legal moves. Customer copy never says "confirmed" unless the state is `confirmed`.
- `fulfilment/src/orchestrator.ts`: the order of operations, with each supplier write recorded as `sent` before it is made.
  1. Confirm the authorisation exists and the hold has not lapsed.
  2. Revalidate the fare. A change or expiry releases the authorisation.
  3. Create the order once, under the key `booking:{id}:supplier_order:1`.
  4. If the supplier says payment is due, pay once, under `booking:{id}:supplier_ticket:1`.
  5. Read the documents back. Status comes only from the supplier's snapshot.
  6. Capture only when every seat-occupying passenger has a document. Capture rules are re-checked by the payments module.
- `fulfilment/src/privacy.ts`: role-based views. Customers see names and full ticket numbers. Support sees date of birth and nationality, with ticket numbers masked. Finance sees no personal data. No passport or document-number field exists.
- `fulfilment/src/customer-view.ts`: tickets are shown only in states where the supplier has issued them.
- `fulfilment/src/fixture-orders.ts`: development fixture with failure knobs. Ticket numbers are prefixed `FX-`, booking references `FXREF`, so they cannot be mistaken for real ones.

## Failure handling

| Situation | Outcome | Money |
|---|---|---|
| Fare changed before order | `failed` | authorisation released |
| Hold lapsed before order | `expired` | authorisation released |
| Order request refused (definitive) | `failed` | authorisation released |
| Order request timed out or errored | `order_unknown` (locked) | authorisation kept, nothing re-sent |
| Payment refused for price or schedule change | unpaid order cancelled, `failed` | authorisation released |
| Payment reply lost | `ticketing_unknown` (locked) | authorisation kept; polling reads the supplier's state |
| Tickets delayed | `ticketing_pending`, polled | not captured until tickets exist |
| Some tickets missing | `partially_fulfilled` | not captured; a person decides |
| Cancellation after capture | refunded through the payments module | refund of captured amount |
| Cancellation before capture | `cancelled` | authorisation released |

## Known limitations

- The infant rule is an assumption. Only seat-occupying passengers must have a document. Confirm with the supplier.
- "Partially fulfilled" is counted per passenger index. It does not check the ticket's full passenger name.
- No database persistence. The store is in memory.
- No automatic reconciliation. A locked booking needs a person to check the airline's records. Duffel's list-orders endpoint may help, but it is not built.
- Cancellation requires the adapter to hide the two-step flow. Duffel's adapter does not exist for orders yet.
- No screens are built. `customer-view.ts` supplies the content and rules only.

## Decisions for the owner

1. Approve Duffel sandbox access so the create-order schema and idempotency can be verified.
2. Approve the operational process for locked bookings (who reconciles, and how fast).
3. Confirm the infant document rule with the supplier.
4. Approve company funding of the Duffel balance. Paying the airline from our balance before capture means we carry the risk if capture fails. This is an outstanding dependency.
5. Approve production ticketing only after a signed supplier agreement, live credentials, and the operational runbook exist.
