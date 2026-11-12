// Provider-independent flight supply interface. Booking logic depends only on this
// file. Adapters (mock, Duffel, and later others) implement it. No provider SDK
// types leak past an adapter.

import type { CurrencyCode, Money } from '../../core/src/money.ts';

export type CabinClass = 'economy' | 'premium_economy' | 'business' | 'first';

export interface SearchRequest {
  readonly origin: string; // IATA airport code, e.g. "LOS"
  readonly destination: string; // IATA airport code, e.g. "LHR"
  readonly departureDate: string; // YYYY-MM-DD in the origin airport's local date
  readonly returnDate?: string; // YYYY-MM-DD; present only for round trips
  readonly passengers: number; // seat-occupying passengers (adults + children)
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
  readonly fare?: FareDetails;
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

export interface FlightSupplier {
  readonly name: string;
  readonly mode: SupplierMode;
  readonly capabilities: { readonly holds: boolean };
  search(request: SearchRequest): Promise<readonly Offer[]>;
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
  | 'offer_expired';

export class SupplierUnavailableError extends Error {
  readonly reason: SupplierFailureReason;

  constructor(reason: SupplierFailureReason, message: string) {
    super(message);
    this.name = 'SupplierUnavailableError';
    this.reason = reason;
  }
}
