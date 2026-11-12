// Deterministic fake supplier. Used in development and tests so the booking flow
// can be built before any supplier contract exists. Output never depends on time
// or randomness, so tests are repeatable.

import type { CurrencyCode } from '../../../core/src/money.ts';
import { money } from '../../../core/src/money.ts';
import type { FlightSupplier, Offer, SearchRequest, Segment } from '../supplier.ts';

interface Route {
  readonly origin: string;
  readonly destination: string;
  readonly originZone: string;
  readonly destinationZone: string;
  readonly durationMinutes: number;
  readonly baseUsdMinor: number;
}

// A small catalogue including international departures from Nigeria.
const ROUTES: readonly Route[] = [
  { origin: 'LOS', destination: 'LHR', originZone: 'Africa/Lagos', destinationZone: 'Europe/London', durationMinutes: 425, baseUsdMinor: 68000 },
  { origin: 'LOS', destination: 'DXB', originZone: 'Africa/Lagos', destinationZone: 'Asia/Dubai', durationMinutes: 380, baseUsdMinor: 52000 },
  { origin: 'LOS', destination: 'JFK', originZone: 'Africa/Lagos', destinationZone: 'America/New_York', durationMinutes: 780, baseUsdMinor: 91000 },
];

const CABIN_MULTIPLIER: Record<SearchRequest['cabin'], number> = {
  economy: 1,
  premium_economy: 1.6,
  business: 3.2,
  first: 5,
};

// Fixed FX table for the mock only. Real rates come from the FX provider and are
// snapshotted per booking.
const MOCK_USD_RATES: Record<CurrencyCode, number> = {
  USD: 1,
  GBP: 0.79,
  EUR: 0.92,
  NGN: 1500,
};

export class MockFlightSupplier implements FlightSupplier {
  readonly name = 'mock';
  readonly mode = 'mock' as const;

  async search(request: SearchRequest): Promise<readonly Offer[]> {
    if (request.passengers < 1 || request.passengers > 9) {
      throw new RangeError('Passengers must be between 1 and 9');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(request.departureDate)) {
      throw new RangeError('departureDate must be YYYY-MM-DD');
    }

    return ROUTES.filter((route) => route.origin === request.origin && route.destination === request.destination).map(
      (route) => this.buildOffer(route, request),
    );
  }

  private buildOffer(route: Route, request: SearchRequest): Offer {
    const multiplier = CABIN_MULTIPLIER[request.cabin];
    const perPersonUsd = Math.round(route.baseUsdMinor * multiplier);
    const totalUsd = perPersonUsd * request.passengers;
    const supplierPrice = money(totalUsd, 'USD');

    const displayMinor = Math.round(totalUsd * MOCK_USD_RATES[request.displayCurrency]);
    const displayPrice = money(displayMinor, request.displayCurrency);

    const departureUtc = `${request.departureDate}T08:00:00Z`;
    const arrivalUtc = addMinutes(departureUtc, route.durationMinutes);

    const segment: Segment = {
      origin: route.origin,
      destination: route.destination,
      departureUtc,
      arrivalUtc,
      departureTimeZone: route.originZone,
      arrivalTimeZone: route.destinationZone,
      carrier: 'MK',
      flightNumber: `MK${100 + route.destination.charCodeAt(0) % 100}`,
    };

    return {
      id: `mock_${route.origin}_${route.destination}_${request.cabin}_${request.passengers}`,
      supplierPrice,
      displayPrice,
      expiresAtUtc: `${request.departureDate}T00:00:00Z`,
      segments: [segment],
    };
  }
}

function addMinutes(isoUtc: string, minutes: number): string {
  return new Date(Date.parse(isoUtc) + minutes * 60_000).toISOString().replace('.000Z', 'Z');
}
