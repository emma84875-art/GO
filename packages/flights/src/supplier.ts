// Provider-independent flight supply interface. Booking logic depends only on this
// file. Adapters (mock, Duffel, and later others) implement it. No provider SDK
// types leak past an adapter.

import type { CurrencyCode, Money } from '../../core/src/money.ts';

export type CabinClass = 'economy' | 'premium_economy' | 'business' | 'first';

// One journey of a search. A one-way search has one leg, a return search has two (the second
// reversed), and a multi-city search has two to six legs in travel order.
export interface SearchLeg {
  readonly origin: string; // IATA airport code
  readonly destination: string; // IATA airport code
  readonly departureDate: string; // YYYY-MM-DD in the origin airport's local date
}

export interface SearchRequest {
  // For a one-way or return search these three fields and returnDate describe the journeys.
  // For a multi-city search they describe the first leg only, and legs is authoritative.
  readonly origin: string; // IATA airport code, e.g. "LOS"
  readonly destination: string; // IATA airport code, e.g. "LHR"
  readonly departureDate: string; // YYYY-MM-DD in the origin airport's local date
  readonly returnDate?: string; // YYYY-MM-DD; present only for round trips
  readonly legs?: readonly SearchLeg[]; // present only for multi-city searches (2 to 6 legs)
  readonly passengers: number; // seat-occupying passengers (adults + children)
  // Adults and children, sent to the supplier with their own passenger types. When absent, `passengers`
  // counts adults (the form used before children were separated).
  readonly adults?: number;
  readonly children?: number;
  readonly infants?: number; // lap infants, not seat-occupying; never more than adults
  readonly cabin: CabinClass;
  readonly displayCurrency: CurrencyCode;
}

export interface Segment {
  readonly origin: string;
  readonly destination: string;
  readonly departureUtc: string; // ISO 8601, UTC
  readonly arrivalUtc: string; // ISO 8601, UTC
  readonly departureTimeZone: string; // IANA zone of the origin airport
  readonly arrivalTimeZone: string; // IANA zone of the destination airport
  readonly carrier: string; // IATA airline code
  readonly flightNumber: string;
}

// What the fare includes and restricts. Null means the supplier did not say.
// Null must be shown to the customer as "not confirmed", never as "none".
export interface FareDetails {
  readonly checkedBags: number | null;
  readonly cabinBags: number | null;
  readonly refundable: boolean | null;
  readonly changeable: boolean | null;
  readonly restrictions: readonly string[];
}

export interface Offer {
  readonly id: string;
  readonly supplierPrice: Money; // in the supplier's settlement currency
  readonly displayPrice: Money; // in the requested display currency
  readonly expiresAtUtc: string;
  readonly segments: readonly Segment[]; // outbound journey
  readonly returnSegments?: readonly Segment[]; // return journey, round trips only
  // One entry per journey, in travel order: outbound first. Present on offers from the search service.
  // Use journeysOf() to read it, so offers without it still work.
  readonly journeys?: readonly (readonly Segment[])[];
  readonly fare?: FareDetails;
  // What the supplier says about identity documents for this offer. Absent means unknown, and
  // unknown never triggers document collection. Only a supplier statement sets 'required' or 'optional'.
  readonly identityDocumentRequirement?: 'required' | 'optional' | 'not_required';
}

export type SupplierMode = 'mock' | 'sandbox' | 'production';

// Passenger data sent to a supplier when placing a hold. Travel-document numbers are
// deliberately absent: they are sent only when a route requires them and the storage
// and retention review is complete.
export interface HoldPassenger {
  readonly type: 'adult' | 'child' | 'infant';
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string; // YYYY-MM-DD
  readonly nationality: string; // ISO 3166-1 alpha-2
}

export interface HoldResult {
  readonly holdId: string;
  readonly status: 'held'; // a hold is NOT a ticket or a confirmed booking
  readonly expiresAtUtc: string; // seats are held until this moment
}

// Offers the supplier returned but GO could not show. They are counted, never silently dropped, and the
// customer is told how many were left out and why. Currency codes are listed only when they are valid ISO
// codes, so a supplier's text is never echoed to the page.
export interface ExcludedOffers {
  readonly invalidCurrency: number; // offers priced in a currency GO does not support
  readonly currencies: readonly string[]; // distinct unsupported codes, each three capital letters
  readonly invalidPrice: number; // offers whose price is missing, unreadable, zero or too large
  readonly malformed: number; // offers whose structure is unreadable (missing id, expiry or journeys)
}

export const NO_EXCLUDED_OFFERS: ExcludedOffers = Object.freeze({
  invalidCurrency: 0,
  currencies: Object.freeze([]),
  invalidPrice: 0,
  malformed: 0,
});

export interface SupplierSearchResult {
  readonly offers: readonly Offer[];
  readonly excluded: ExcludedOffers;
}

export interface FlightSupplier {
  readonly name: string;
  readonly mode: SupplierMode;
  readonly capabilities: { readonly holds: boolean; readonly orders?: boolean };
  search(request: SearchRequest): Promise<readonly Offer[]>;
  // Like search, and also reports the offers left out. The search service uses this when it is present.
  searchDetailed?(request: SearchRequest): Promise<SupplierSearchResult>;
  // Re-prices an offer just before it is held or paid for. Throws
  // SupplierUnavailableError("offer_expired") if the offer can no longer be sold.
  priceOffer?(offer: Offer, nowUtc: string): Promise<Offer>;
  // Places a hold. The key makes retries safe: the same key must never create a second hold.
  createHold?(offer: Offer, passengers: readonly HoldPassenger[], idempotencyKey: string, nowUtc: string): Promise<HoldResult>;
}

// Thrown by adapters when a supplier cannot answer. The reason is machine-readable
// so the UI can show the right state without guessing.
export type SupplierFailureReason =
  | 'not_configured'
  | 'production_not_approved'
  | 'timeout'
  | 'provider_error'
  | 'invalid_response'
  | 'fx_unavailable'
  | 'offer_expired'
  | 'price_changed'
  | 'schedule_changed'
  | 'order_not_found';

export class SupplierUnavailableError extends Error {
  readonly reason: SupplierFailureReason;

  constructor(reason: SupplierFailureReason, message: string) {
    super(message);
    this.name = 'SupplierUnavailableError';
    this.reason = reason;
  }
}

// ---- Order and ticket operations (Phase 10) ----------------------------------------

// A ticket document as the supplier reports it. The number is shown only to the customer
// who owns the booking and to support staff, never in logs.
export interface TicketDocument {
  readonly type: 'electronic_ticket' | 'other';
  readonly number: string;
  readonly passengerIndex: number; // index into the order's passenger list
}

// Supplier's view of an order at one moment. Read, never inferred.
export interface OrderSnapshot {
  readonly orderId: string;
  readonly bookingReference: string | null; // airline record locator
  readonly awaitingPayment: boolean;
  readonly paymentRequiredByUtc: string | null;
  readonly documents: readonly TicketDocument[];
  readonly cancelled: boolean;
  readonly paidAmountMinor: number | null;
  readonly currency: string;
}

export interface CreateOrderResult {
  readonly orderId: string;
  readonly snapshot: OrderSnapshot;
}

export interface CancellationOutcome {
  readonly status: 'confirmed';
  readonly refundAmountMinor: number | null; // null means the supplier has not said
}

// Optional: adapters implement only what the supplier documents. Each write takes an
// idempotency key that the adapter must not send twice for the same logical operation.
export interface FlightOrderOperations {
  createOrder(
    offer: Offer,
    passengers: readonly HoldPassenger[],
    idempotencyKey: string,
    nowUtc: string,
  ): Promise<CreateOrderResult>;
  getOrder(orderId: string): Promise<OrderSnapshot>;
  payOrder(orderId: string, amountMinor: number, currency: string, idempotencyKey: string): Promise<OrderSnapshot>;
  cancelOrder(orderId: string, idempotencyKey: string): Promise<CancellationOutcome>;
}

// The legs of a request, whatever its shape. One-way: one leg. Return: two legs. Multi-city: its legs.
export function legsOf(request: SearchRequest): readonly SearchLeg[] {
  if (request.legs !== undefined) return request.legs;
  const outbound: SearchLeg = { origin: request.origin, destination: request.destination, departureDate: request.departureDate };
  if (request.returnDate === undefined) return [outbound];
  return [outbound, { origin: request.destination, destination: request.origin, departureDate: request.returnDate }];
}

// The journeys of an offer, in travel order, whatever the offer shape.
export function journeysOf(offer: Offer): readonly (readonly Segment[])[] {
  if (offer.journeys !== undefined) return offer.journeys;
  return offer.returnSegments !== undefined ? [offer.segments, offer.returnSegments] : [offer.segments];
}
