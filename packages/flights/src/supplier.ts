// Provider-independent flight supply interface. Booking logic depends only on this
// file. Adapters (mock, Duffel, and later others) implement it. No provider SDK
// types leak past an adapter.

import type { CurrencyCode, Money } from '../../core/src/money.ts';

export interface SearchRequest {
  readonly origin: string; // IATA airport code, e.g. "LOS"
  readonly destination: string; // IATA airport code, e.g. "LHR"
  readonly departureDate: string; // YYYY-MM-DD in the origin airport's local date
  readonly passengers: number;
  readonly cabin: 'economy' | 'premium_economy' | 'business' | 'first';
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

export interface Offer {
  readonly id: string;
  readonly supplierPrice: Money; // in the supplier's settlement currency
  readonly displayPrice: Money; // in the requested display currency
  readonly expiresAtUtc: string;
  readonly segments: readonly Segment[];
}

export interface FlightSupplier {
  readonly name: string;
  readonly mode: 'mock' | 'sandbox' | 'production';
  search(request: SearchRequest): Promise<readonly Offer[]>;
}
