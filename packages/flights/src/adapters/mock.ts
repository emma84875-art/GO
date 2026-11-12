// Deterministic development fixture supplier. Every offer it returns is FAKE. The
// fare rules, baggage and prices are placeholders to exercise the booking flow and
// tests. They must never be shown to customers as real. The UI shows mode "mock" as
// "Development fixture". Output depends only on the input, never on time or random
// values, so tests are repeatable.

import type { CurrencyCode } from '../../../core/src/money.ts';
import { money } from '../../../core/src/money.ts';
import {
  SupplierUnavailableError,
  type CabinClass,
  type FlightSupplier,
  type HoldPassenger,
  type HoldResult,
  type Offer,
  type SearchRequest,
  type Segment,
} from '../supplier.ts';

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

const CABIN_MULTIPLIER: Record<CabinClass, number> = {
  economy: 1,
  premium_economy: 1.6,
  business: 3.2,
  first: 5,
};

const FIXTURE_BAGS: Record<CabinClass, number> = {
  economy: 1,
  premium_economy: 2,
  business: 2,
  first: 3,
};

// Fixed FX table for the fixture only. Real rates come from the FX provider and are
// snapshotted per booking.
const MOCK_USD_RATES: Record<CurrencyCode, number> = {
  USD: 1,
  GBP: 0.79,
  EUR: 0.92,
  NGN: 1500,
};

export class MockFlightSupplier implements FlightSupplier {
  readonly name = 'mock';
  readonly mode = "mock" as const;
  readonly capabilities = { holds: true };

  // Fixture behaviour: an offer is valid until its expiry, then reports expired.
  async priceOffer(offer: Offer, nowUtc: string): Promise<Offer> {
    if (Date.parse(offer.expiresAtUtc) <= Date.parse(nowUtc)) {
      throw new SupplierUnavailableError("offer_expired", "Fixture offer has expired");
    }
    return offer;
  }

  // Fixture hold. The hold id is derived from the idempotency key, so a retry with the
  // same key returns the same hold and cannot create a second one.
  async createHold(
    offer: Offer,
    passengers: readonly HoldPassenger[],
    idempotencyKey: string,
    nowUtc: string,
  ): Promise<HoldResult> {
    if (passengers.length === 0) throw new RangeError("A hold needs at least one passenger");
    await this.priceOffer(offer, nowUtc);
    return {
      holdId: "fixture_" + idempotencyKey.replace(/[^a-z0-9]+/gi, "_"),
      status: "held",
      expiresAtUtc: addMinutes(nowUtc.replace(/\.\d{3}Z$/, "Z"), 30),
    };
  }

  async search(request: SearchRequest): Promise<readonly Offer[]> {
    const infants = request.infants ?? 0;
    if (request.passengers < 1 || request.passengers > 9) {
      throw new RangeError('Passengers must be between 1 and 9');
    }
    if (infants < 0 || infants > request.passengers) {
      throw new RangeError('Each infant needs an adult travelling with them');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(request.departureDate)) {
      throw new RangeError('departureDate must be YYYY-MM-DD');
    }
    if (request.returnDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(request.returnDate)) {
      throw new RangeError('returnDate must be YYYY-MM-DD');
    }

    return ROUTES.filter((route) => route.origin === request.origin && route.destination === request.destination).map(
      (route) => this.buildOffer(route, request),
    );
  }

  private buildOffer(route: Route, request: SearchRequest): Offer {
    const multiplier = CABIN_MULTIPLIER[request.cabin];
    const perPersonUsd = Math.round(route.baseUsdMinor * multiplier);
    // Infants are priced at a flat tenth of an adult fare in this fixture.
    const payingUnits = request.passengers + (request.infants ?? 0) * 0.1;
    const totalUsd = Math.round(perPersonUsd * payingUnits);
    const supplierPrice = money(totalUsd, 'USD');

    const displayMinor = Math.round(totalUsd * MOCK_USD_RATES[request.displayCurrency]);
    const displayPrice = money(displayMinor, request.displayCurrency);

    const departureUtc = `${request.departureDate}T08:00:00Z`;
    const segment: Segment = {
      origin: route.origin,
      destination: route.destination,
      departureUtc,
      arrivalUtc: addMinutes(departureUtc, route.durationMinutes),
      departureTimeZone: route.originZone,
      arrivalTimeZone: route.destinationZone,
      carrier: 'MK',
      flightNumber: `MK${100 + (route.destination.charCodeAt(0) % 100)}`,
    };

    const returnSegments = request.returnDate
      ? [
          {
            origin: route.destination,
            destination: route.origin,
            departureUtc: `${request.returnDate}T16:00:00Z`,
            arrivalUtc: addMinutes(`${request.returnDate}T16:00:00Z`, route.durationMinutes),
            departureTimeZone: route.destinationZone,
            arrivalTimeZone: route.originZone,
            carrier: 'MK',
            flightNumber: `MK${200 + (route.destination.charCodeAt(0) % 100)}`,
          } satisfies Segment,
        ]
      : undefined;

    return {
      id: `fixture_${route.origin}_${route.destination}_${request.cabin}_${request.passengers}_${request.returnDate ? 'rt' : 'ow'}`,
      supplierPrice,
      displayPrice,
      expiresAtUtc: `${request.departureDate}T00:00:00Z`,
      segments: [segment],
      ...(returnSegments ? { returnSegments } : {}),
      fare: {
        checkedBags: FIXTURE_BAGS[request.cabin],
        cabinBags: 1,
        refundable: false,
        changeable: true,
        restrictions: ['Development fixture: fare rules are placeholders, not a real fare'],
      },
    };
  }
}

function addMinutes(isoUtc: string, minutes: number): string {
  return new Date(Date.parse(isoUtc) + minutes * 60_000).toISOString().replace('.000Z', 'Z');
}
