// Duffel adapter. STATUS: prepared, not verified against a live sandbox.
//
// - Requires DUFFEL_ACCESS_TOKEN (sandbox or live). Without it, search() throws
//   SupplierUnavailableError('not_configured') and makes no network call.
// - Production mode is refused unless productionApproved is true. Only the owner
//   sets that, after a signed supplier agreement exists. It defaults to false.
// - Request and response field names follow Duffel's public API documentation as
//   read from secondary sources. They must be checked against the real sandbox
//   before this adapter is trusted. Responses in tests are SYNTHETIC fixtures.
// - Duffel's business approval is NOT assumed. See docs/05.

import type { CurrencyCode, Money } from '../../../core/src/money.ts';
import { isCurrencyCode, money } from '../../../core/src/money.ts';
import type { FxRateSnapshot } from '../../../core/src/pricing.ts';
import { convertMoney } from '../../../core/src/pricing.ts';
import { findAirport } from '../airports.ts';
import {
  SupplierUnavailableError,
  type FareDetails,
  type FlightSupplier,
  type Offer,
  type SearchRequest,
  type Segment,
} from '../supplier.ts';

export const DUFFEL_BASE_URL = 'https://api.duffel.com';
export const DUFFEL_VERSION_HEADER = 'v2';

export interface HttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type HttpTransport = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<HttpResponse>;

export interface DuffelConfig {
  readonly mode: 'sandbox' | 'production';
  readonly accessToken?: string;
  readonly productionApproved?: boolean;
  readonly timeoutMs?: number;
  readonly transport?: HttpTransport; // injected in tests; defaults to fetch
  readonly fxSnapshot?: (from: CurrencyCode, to: CurrencyCode) => FxRateSnapshot | undefined;
}

const CABIN_MAP: Record<SearchRequest['cabin'], string> = {
  economy: 'economy',
  premium_economy: 'premium_economy',
  business: 'business',
  first: 'first',
};

// Builds the offer request body. Infants are listed as infant_without_seat.
export function buildDuffelOfferRequest(request: SearchRequest): Record<string, unknown> {
  const slices: { origin: string; destination: string; departure_date: string }[] = [
    { origin: request.origin, destination: request.destination, departure_date: request.departureDate },
  ];
  if (request.returnDate) {
    slices.push({ origin: request.destination, destination: request.origin, departure_date: request.returnDate });
  }
  const passengers: { type: string }[] = [
    ...Array.from({ length: request.passengers }, () => ({ type: 'adult' })),
    ...Array.from({ length: request.infants ?? 0 }, () => ({ type: 'infant_without_seat' })),
  ];
  return {
    data: {
      slices,
      passengers,
      cabin_class: CABIN_MAP[request.cabin],
    },
  };
}

// Converts a decimal string such as "512.34" to integer minor units without floats.
export function parseDecimalToMinor(value: unknown, exponent = 2): number {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) {
    throw new SupplierUnavailableError('invalid_response', 'Amount is not a decimal string');
  }
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > exponent) {
    throw new SupplierUnavailableError('invalid_response', 'Amount has more decimal places than the currency allows');
  }
  const padded = fraction.padEnd(exponent, '0');
  return Number(whole + padded);
}

interface RawSegment {
  departing_at?: string;
  arriving_at?: string;
  origin?: { iata_code?: string; time_zone?: string };
  destination?: { iata_code?: string; time_zone?: string };
  marketing_carrier?: { iata_code?: string };
  marketing_carrier_flight_number?: string;
}

function normaliseSegments(rawSegments: unknown): Segment[] {
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    throw new SupplierUnavailableError('invalid_response', 'Slice has no segments');
  }
  return rawSegments.map((raw: RawSegment) => {
    const originCode = raw.origin?.iata_code;
    const destCode = raw.destination?.iata_code;
    if (!originCode || !destCode || !raw.departing_at || !raw.arriving_at) {
      throw new SupplierUnavailableError('invalid_response', 'Segment is missing required fields');
    }
    // Time zone comes from the supplier when present, otherwise from our airport data.
    const departureTimeZone = raw.origin?.time_zone ?? findAirport(originCode)?.timeZone;
    const arrivalTimeZone = raw.destination?.time_zone ?? findAirport(destCode)?.timeZone;
    if (!departureTimeZone || !arrivalTimeZone) {
      throw new SupplierUnavailableError('invalid_response', `Unknown time zone for ${originCode} or ${destCode}`);
    }
    return {
      origin: originCode,
      destination: destCode,
      departureUtc: new Date(raw.departing_at).toISOString().replace('.000Z', 'Z'),
      arrivalUtc: new Date(raw.arriving_at).toISOString().replace('.000Z', 'Z'),
      departureTimeZone,
      arrivalTimeZone,
      carrier: raw.marketing_carrier?.iata_code ?? '',
      flightNumber: raw.marketing_carrier_flight_number ?? '',
    };
  });
}

interface RawOffer {
  id?: string;
  total_amount?: string;
  total_currency?: string;
  expires_at?: string;
  slices?: { segments?: RawSegment[] }[];
  conditions?: {
    refund_before_departure?: { allowed?: boolean } | null;
    change_before_departure?: { allowed?: boolean } | null;
  };
  available_services?: unknown;
  passengers?: { baggages?: { type?: string; quantity?: number }[] }[];
}

// Fare details are read only where the supplier states them. Anything absent is null.
function normaliseFare(raw: RawOffer): FareDetails {
  const checked = raw.passengers?.[0]?.baggages?.find((b) => b.type === 'checked');
  return {
    checkedBags: typeof checked?.quantity === 'number' ? checked.quantity : null,
    cabinBags: null,
    refundable: typeof raw.conditions?.refund_before_departure?.allowed === 'boolean'
      ? raw.conditions.refund_before_departure.allowed
      : null,
    changeable: typeof raw.conditions?.change_before_departure?.allowed === 'boolean'
      ? raw.conditions.change_before_departure.allowed
      : null,
    restrictions: [],
  };
}

export function normaliseDuffelOffers(
  payload: unknown,
  displayCurrency: CurrencyCode,
  fxSnapshot: DuffelConfig["fxSnapshot"] = () => undefined,
): Offer[] {
  const data = (payload as { data?: { offers?: RawOffer[] } } | null)?.data;
  if (!data || !Array.isArray(data.offers)) {
    throw new SupplierUnavailableError('invalid_response', 'Response has no offers array');
  }

  return data.offers.map((raw) => {
    if (!raw.id || !raw.total_amount || !raw.total_currency || !raw.expires_at || !Array.isArray(raw.slices)) {
      throw new SupplierUnavailableError('invalid_response', 'Offer is missing required fields');
    }
    if (!isCurrencyCode(raw.total_currency)) {
      throw new SupplierUnavailableError('invalid_response', `Unsupported currency ${raw.total_currency}`);
    }
    const supplierPrice: Money = money(parseDecimalToMinor(raw.total_amount), raw.total_currency);
    return {
      id: raw.id,
      supplierPrice,
      displayPrice: supplierPrice, // replaced by applyDisplayCurrency below
      expiresAtUtc: new Date(raw.expires_at).toISOString().replace('.000Z', 'Z'),
      segments: normaliseSegments(raw.slices[0]?.segments),
      ...(raw.slices[1] ? { returnSegments: normaliseSegments(raw.slices[1].segments) } : {}),
      fare: normaliseFare(raw),
    };
  }).map((offer) => applyDisplayCurrency(offer, displayCurrency, fxSnapshot));
}

// Converts the supplier price into the display currency using a snapshot the caller
// supplies. No rate is invented: if no snapshot exists, the offer is rejected.
function applyDisplayCurrency(
  offer: Offer,
  displayCurrency: CurrencyCode,
  fxSnapshot: NonNullable<DuffelConfig["fxSnapshot"]>,
): Offer {
  if (offer.supplierPrice.currency === displayCurrency) {
    return { ...offer, displayPrice: offer.supplierPrice };
  }
  const snapshot = fxSnapshot(offer.supplierPrice.currency, displayCurrency);
  if (!snapshot) {
    throw new SupplierUnavailableError("fx_unavailable", `No FX snapshot for ${offer.supplierPrice.currency} to ${displayCurrency}`);
  }
  return { ...offer, displayPrice: convertMoney(offer.supplierPrice, snapshot) };
}

export class DuffelFlightSupplier implements FlightSupplier {
  readonly name = 'duffel';
  readonly mode: 'sandbox' | 'production';
  private readonly config: DuffelConfig;

  constructor(config: DuffelConfig) {
    this.config = config;
    this.mode = config.mode;
  }

  async search(request: SearchRequest): Promise<readonly Offer[]> {
    if (!this.config.accessToken) {
      throw new SupplierUnavailableError('not_configured', 'Duffel access token is not configured');
    }
    if (this.config.mode === 'production' && this.config.productionApproved !== true) {
      throw new SupplierUnavailableError('production_not_approved', 'Production flight supply is not approved');
    }

    const transport = this.config.transport ?? defaultTransport;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);
    let response: HttpResponse;
    try {
      response = await transport(`${DUFFEL_BASE_URL}/air/offer_requests?return_offers=true`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Duffel-Version': DUFFEL_VERSION_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildDuffelOfferRequest(request)),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = (error as { name?: string }).name === 'AbortError';
      throw new SupplierUnavailableError(
        aborted ? 'timeout' : 'provider_error',
        aborted ? 'Duffel did not respond in time' : 'Could not reach Duffel',
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 400) {
      throw new SupplierUnavailableError('provider_error', `Duffel returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    return normaliseDuffelOffers(payload, request.displayCurrency, this.config.fxSnapshot);
  }
}

async function defaultTransport(url: string, init: Parameters<HttpTransport>[1]): Promise<HttpResponse> {
  return fetch(url, init);
}
