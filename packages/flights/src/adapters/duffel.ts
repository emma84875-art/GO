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
import { isCurrencyCode, minorUnitExponent, money } from '../../../core/src/money.ts';
import type { FxRateSnapshot } from '../../../core/src/pricing.ts';
import { convertMoney } from '../../../core/src/pricing.ts';
import { findAirport } from '../airports.ts';
import {
  SupplierUnavailableError,
  legsOf,
  type SupplierSearchResult,
  type FareDetails,
  type FlightSupplier,
  type Offer,
  type SearchRequest,
  type Segment,
} from '../supplier.ts';

export const DUFFEL_BASE_URL = 'https://api.duffel.com';
export const DUFFEL_VERSION_HEADER = 'v2';
// Duffel test-mode tokens start with this prefix (duffel.com/docs/api/overview/test-mode). Sandbox calls
// accept only these tokens. A live token is refused before any request is sent.
export const DUFFEL_TEST_TOKEN_PREFIX = 'duffel_test_';
// A rate for a conversion is used only while it is this fresh.
const FX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
  // One slice per leg, in travel order: one-way 1, return 2, multi-city 2 to 6.
  const slices = legsOf(request).map((leg) => ({
    origin: leg.origin,
    destination: leg.destination,
    departure_date: leg.departureDate,
  }));
  // Adults, children and infants are sent with their own types. A child is never priced as an adult.
  // Older callers that set only `passengers` are treated as adults, as before.
  const adults = request.adults ?? request.passengers;
  const children = request.children ?? 0;
  const passengers: { type: string }[] = [
    ...Array.from({ length: adults }, () => ({ type: 'adult' })),
    ...Array.from({ length: children }, () => ({ type: 'child' })),
    // Infant pricing is not verified against the sandbox yet. Do not describe infant fares as confirmed.
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
// Digits beyond the currency's exponent are accepted only when they are all zeros ("15000.00" for JPY).
// A non-zero digit beyond the exponent is refused, never rounded.
export function parseDecimalToMinor(value: unknown, exponent = 2): number {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) {
    throw new SupplierUnavailableError('invalid_response', 'Amount is not a decimal string');
  }
  const [whole, fraction = ''] = value.split('.');
  const kept = fraction.slice(0, exponent);
  const extra = fraction.slice(exponent);
  if (/[1-9]/.test(extra)) {
    throw new SupplierUnavailableError('invalid_response', 'Amount has more decimal places than the currency allows');
  }
  const minor = Number(whole + kept.padEnd(exponent, '0'));
  if (!Number.isSafeInteger(minor)) {
    throw new SupplierUnavailableError('invalid_response', 'Amount is too large to represent');
  }
  return minor;
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

export interface NormaliseOptions {
  // The number of journeys the request asked for. When given, an offer with a different number of
  // slices is refused, so a supplier cannot silently drop or add a journey.
  readonly expectedJourneys?: number;
  // True for a multi-city request. Such offers carry every journey in `journeys` and no return fields.
  readonly multiCity?: boolean;
  // The time used to judge whether an FX snapshot is fresh. Defaults to the current time.
  readonly nowMs?: number;
}

// Reads a supplier amount as minor units of its currency. Returns undefined when the amount is not a usable
// price: unreadable, zero, negative or too large to represent. Such an offer is excluded, not shown.
function priceMinorOf(value: unknown, currency: CurrencyCode): number | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const minor = parseDecimalToMinor(value, minorUnitExponent(currency));
    return minor > 0 && Number.isSafeInteger(minor) ? minor : undefined;
  } catch {
    return undefined;
  }
}

// Turns a Duffel response into offers plus a count of what was left out, and why.
// - An offer that is structurally malformed (not an object, missing its id, expiry or journeys, or with an
//   unreadable segment) is skipped and counted as malformed. It never stops the other offers.
// - An offer whose currency is missing, malformed or not a current listed code is skipped and counted as
//   invalidCurrency. Its code is reported only when it has a valid three-letter shape.
// - An offer whose price is not usable is skipped and counted as invalidPrice.
// Only a response with no offers array at all is refused as invalid_response, because that is a supplier fault.
// If every offer is left out, the result has no offers and the counts say why. That is not an error.
export function normaliseDuffelResult(
  payload: unknown,
  displayCurrency: CurrencyCode,
  fxSnapshot: DuffelConfig["fxSnapshot"] = () => undefined,
  options: NormaliseOptions = {},
): SupplierSearchResult {
  const data = (payload as { data?: { offers?: RawOffer[] } } | null)?.data;
  if (!data || !Array.isArray(data.offers)) {
    throw new SupplierUnavailableError('invalid_response', 'Response has no offers array');
  }

  let invalidCurrency = 0;
  let invalidPrice = 0;
  let malformed = 0;
  const codes = new Set<string>();
  const offers: Offer[] = [];

  for (const raw of data.offers) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id.length === 0 ||
        !raw.expires_at || Number.isNaN(Date.parse(raw.expires_at)) || !Array.isArray(raw.slices) || raw.slices.length === 0) {
      malformed += 1;
      continue;
    }
    if (options.expectedJourneys !== undefined && raw.slices.length !== options.expectedJourneys) {
      malformed += 1;
      continue;
    }
    if (!isCurrencyCode(raw.total_currency)) {
      invalidCurrency += 1;
      if (typeof raw.total_currency === 'string' && /^[A-Z]{3}$/.test(raw.total_currency)) codes.add(raw.total_currency);
      continue;
    }
    const minor = priceMinorOf(raw.total_amount, raw.total_currency);
    if (minor === undefined) {
      invalidPrice += 1;
      continue;
    }
    let offer: Offer;
    try {
      const supplierPrice: Money = money(minor, raw.total_currency);
      const journeys = raw.slices.map((slice) => normaliseSegments(slice?.segments));
      offer = {
        id: raw.id,
        supplierPrice,
        displayPrice: supplierPrice, // replaced by applyDisplayCurrency below
        expiresAtUtc: new Date(raw.expires_at).toISOString().replace('.000Z', 'Z'),
        segments: journeys[0],
        ...(!options.multiCity && journeys[1] ? { returnSegments: journeys[1] } : {}),
        journeys,
        fare: normaliseFare(raw),
      };
    } catch {
      malformed += 1;
      continue;
    }
    offers.push(applyDisplayCurrency(offer, displayCurrency, fxSnapshot, options.nowMs ?? Date.now()));
  }

  return {
    offers,
    excluded: { invalidCurrency, currencies: [...codes].sort(), invalidPrice, malformed },
  };
}

// The offers alone, for callers that do not need the exclusion counts.
export function normaliseDuffelOffers(
  payload: unknown,
  displayCurrency: CurrencyCode,
  fxSnapshot: DuffelConfig["fxSnapshot"] = () => undefined,
  options: NormaliseOptions = {},
): Offer[] {
  return normaliseDuffelResult(payload, displayCurrency, fxSnapshot, options).offers;
}

// Sets displayPrice. The supplier's own amount and currency are never changed.
// - Same currency as requested: displayPrice is the supplier price.
// - Different currency, with a fresh snapshot for that pair: displayPrice is the converted amount.
// - Otherwise: displayPrice stays in the supplier's currency. The result page labels it, and GO never
//   shows that amount as the requested currency. One offer that cannot be converted does not stop the others.
function applyDisplayCurrency(
  offer: Offer,
  displayCurrency: CurrencyCode,
  fxSnapshot: NonNullable<DuffelConfig["fxSnapshot"]>,
  nowMs: number,
): Offer {
  if (offer.supplierPrice.currency === displayCurrency) {
    return { ...offer, displayPrice: offer.supplierPrice };
  }
  const snapshot = fxSnapshot(offer.supplierPrice.currency, displayCurrency);
  // The snapshot must convert exactly this pair: from the supplier's currency to the requested one.
  // A snapshot for any other pair, including a reversed one, is ignored.
  if (
    !snapshot ||
    snapshot.from !== offer.supplierPrice.currency ||
    snapshot.to !== displayCurrency ||
    !isFreshSnapshot(snapshot, nowMs)
  ) {
    return { ...offer, displayPrice: offer.supplierPrice };
  }
  try {
    return { ...offer, displayPrice: convertMoney(offer.supplierPrice, snapshot) };
  } catch {
    // A snapshot that does not match the pair is treated as no snapshot.
    return { ...offer, displayPrice: offer.supplierPrice };
  }
}

// A snapshot is used only with a valid, recent capture time. Anything else counts as no snapshot.
function isFreshSnapshot(snapshot: FxRateSnapshot, nowMs: number): boolean {
  const captured = Date.parse(snapshot.capturedAtUtc);
  if (Number.isNaN(captured)) return false;
  const age = nowMs - captured;
  return age >= 0 && age <= FX_MAX_AGE_MS;
}

export class DuffelFlightSupplier implements FlightSupplier {
  readonly name = 'duffel';
  readonly mode: 'sandbox' | 'production';
  // Holds stay off until Duffel's hold rules are verified in the sandbox. A hold is
  // only possible where the offer does not require instant payment (see docs/05).
  readonly capabilities = { holds: false };
  private readonly config: DuffelConfig;

  constructor(config: DuffelConfig) {
    // Defence in depth: the configuration already refuses live tokens. The message never includes the token.
    if (config.mode === 'sandbox' && config.accessToken !== undefined && !config.accessToken.startsWith(DUFFEL_TEST_TOKEN_PREFIX)) {
      throw new TypeError('Sandbox mode requires a Duffel test token');
    }
    this.config = config;
    this.mode = config.mode;
  }

  async search(request: SearchRequest): Promise<readonly Offer[]> {
    return (await this.searchDetailed(request)).offers;
  }

  async searchDetailed(request: SearchRequest): Promise<SupplierSearchResult> {
    if (!this.config.accessToken) {
      throw new SupplierUnavailableError('not_configured', 'Duffel access token is not configured');
    }
    if (this.config.mode === 'production' && this.config.productionApproved !== true) {
      throw new SupplierUnavailableError('production_not_approved', 'Production flight supply is not approved');
    }

    const transport = this.config.transport ?? defaultTransport;
    const controller = new AbortController();
    // The timer covers the whole exchange: the request, the response and the body. It is cleared only when
    // the body has been read or the request has failed, so a slow body cannot hold the call open.
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);
    try {
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
        throw failureOf(error, 'Could not reach Duffel');
      }

      if (response.status >= 400) {
        throw new SupplierUnavailableError('provider_error', `Duffel returned HTTP ${response.status}`);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw failureOf(error, 'Duffel returned a response that could not be read');
      }
      return normaliseDuffelResult(payload, request.displayCurrency, this.config.fxSnapshot, {
        expectedJourneys: legsOf(request).length,
        multiCity: request.legs !== undefined,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

// Maps a failure from the network or the body read. An abort is a timeout. Anything else is reported
// with a fixed message, never the underlying error text.
function failureOf(error: unknown, message: string): SupplierUnavailableError {
  if (error instanceof SupplierUnavailableError) return error;
  const aborted = (error as { name?: string } | null)?.name === 'AbortError';
  return aborted
    ? new SupplierUnavailableError('timeout', 'Duffel did not respond in time')
    : new SupplierUnavailableError('provider_error', message);
}

async function defaultTransport(url: string, init: Parameters<HttpTransport>[1]): Promise<HttpResponse> {
  return fetch(url, init);
}
