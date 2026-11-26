// Flight search for the browser. The browser never talks to a supplier directly: supplier keys (Duffel)
// live only on the server, and the browser can call only the same-origin search endpoint in config.js.
//
// While FLIGHT_SEARCH_ENDPOINT is null, no request is made and the result is 'unavailable' with reason
// 'not_configured'. The app never shows example or estimated fares in its place.

import config from '../config.js';
import { isCurrencyCode } from '../vendor/packages/core/src/money.js';
import { SupplierUnavailableError } from '../vendor/packages/flights/src/supplier.js';
import { runFlightSearch } from '../vendor/packages/flights/src/search-service.js';

// The browser waits longer than the service waits for the supplier (SEARCH_SUPPLIER_TIMEOUT_MS, 15 s by
// default). On the free Render plan the service can take a long time to wake, and the supplier wait comes
// on top. 75 s covers both. The wake-up time is an estimate until staging measures it.
export const SEARCH_TIMEOUT_MS = 75000;

// A displayed price must be a positive whole number of minor units in a supported currency.
function money(value) {
  return Boolean(value) && Number.isSafeInteger(value.amountMinor) && value.amountMinor > 0 && isCurrencyCode(value.currency);
}

// Reads the exclusion counts the service reports. Anything malformed becomes "nothing excluded", and only valid
// three-letter currency codes are kept, so no text from the service reaches the page through this path.
export function excludedFrom(value) {
  const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
  if (!value || typeof value !== 'object') return { invalidCurrency: 0, currencies: [], invalidPrice: 0, malformed: 0 };
  const currencies = Array.isArray(value.currencies)
    ? value.currencies.filter((code) => typeof code === 'string' && /^[A-Z]{3}$/.test(code)).slice(0, 20)
    : [];
  return {
    invalidCurrency: count(value.invalidCurrency),
    currencies,
    invalidPrice: count(value.invalidPrice),
    malformed: count(value.malformed),
  };
}

// Every offer the page drops is counted, so nothing is lost silently. Money problems are counted as currency or
// price problems. Anything else that is structurally unreadable is counted as malformed.
function droppedReason(raw) {
  const price = raw?.displayPrice;
  if (isOfferShape(raw)) return null;
  if (price && typeof price === 'object' && !isCurrencyCode(price.currency)) {
    return { kind: 'invalidCurrency', code: typeof price.currency === 'string' && /^[A-Z]{3}$/.test(price.currency) ? price.currency : null };
  }
  if (price && typeof price === 'object' && isCurrencyCode(price.currency) && !money(price)) {
    return { kind: 'invalidPrice', code: null };
  }
  return { kind: 'malformed', code: null };
}

// Merges the service's counts with the offers this page dropped for money reasons.
function mergeExcluded(serviceExcluded, dropped) {
  const currencies = new Set(serviceExcluded.currencies);
  for (const code of dropped.codes) currencies.add(code);
  return {
    invalidCurrency: serviceExcluded.invalidCurrency + dropped.invalidCurrency,
    currencies: [...currencies].sort().slice(0, 20),
    invalidPrice: serviceExcluded.invalidPrice + dropped.invalidPrice,
    malformed: serviceExcluded.malformed + dropped.malformed,
  };
}

function segmentOk(segment) {
  return Boolean(segment) &&
    typeof segment.origin === 'string' &&
    typeof segment.destination === 'string' &&
    typeof segment.carrier === 'string' &&
    typeof segment.flightNumber === 'string' &&
    typeof segment.departureTimeZone === 'string' &&
    typeof segment.arrivalTimeZone === 'string' &&
    !Number.isNaN(Date.parse(segment.departureUtc)) &&
    !Number.isNaN(Date.parse(segment.arrivalUtc));
}

// An offer is shown only if every field the page relies on is present and valid. Anything else is dropped.
export function isOfferShape(offer) {
  return Boolean(offer) &&
    typeof offer.id === 'string' &&
    money(offer.displayPrice) &&
    typeof offer.expiresAtUtc === 'string' &&
    !Number.isNaN(Date.parse(offer.expiresAtUtc)) &&
    Array.isArray(offer.segments) &&
    offer.segments.length > 0 &&
    offer.segments.every(segmentOk) &&
    (offer.returnSegments === undefined || (Array.isArray(offer.returnSegments) && offer.returnSegments.every(segmentOk))) &&
    (offer.journeys === undefined || (
      Array.isArray(offer.journeys) &&
      offer.journeys.length > 0 &&
      offer.journeys.every((journey) => Array.isArray(journey) && journey.length > 0 && journey.every(segmentOk))
    ));
}

// The endpoint must be an absolute https URL (or http on localhost for development). Anything else is
// treated as not connected, so no request is sent to an address that was not chosen on purpose.
export function isUsableEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

// The reasons the search service names in its unavailable answers. Anything else becomes provider_error.
const SERVICE_REASONS = new Set([
  'not_configured', 'production_not_approved', 'timeout', 'provider_error', 'invalid_response', 'fx_unavailable',
]);

// The supplier posts the customer's search input (not the supplier request), because the service
// validates and maps it itself. The request argument from runFlightSearch is not sent.
export function createSearchSupplier({ endpoint, input, mode = 'sandbox', fetchImpl = globalThis.fetch, timeoutMs = SEARCH_TIMEOUT_MS }) {
  return {
    name: 'search-service',
    mode,
    capabilities: { holds: false },
    async search() {
      return (await this.searchDetailed()).offers;
    },
    async searchDetailed() {
      if (!isUsableEndpoint(endpoint) || input === undefined) {
        throw new SupplierUnavailableError('not_configured', 'Flight search is not connected yet.');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new SupplierUnavailableError('timeout', 'The flight provider did not respond in time.');
        }
        throw new SupplierUnavailableError('provider_error', 'Could not reach the flight search service.');
      } finally {
        clearTimeout(timer);
      }
      let body;
      try {
        body = await response.json();
      } catch {
        if (!response.ok) throw new SupplierUnavailableError('provider_error', 'The flight search service could not complete the search.');
        throw new SupplierUnavailableError('invalid_response', 'The flight results could not be read.');
      }
      if (!response.ok) {
        // The service names the reason in its own unavailable answer. Use it when it is one we know.
        if (body?.status === 'unavailable' && SERVICE_REASONS.has(body.reason)) {
          throw new SupplierUnavailableError(body.reason, 'The flight search service reported this state.');
        }
        throw new SupplierUnavailableError('provider_error', 'The flight search service could not complete the search.');
      }
      const raw = body?.offers;
      if (!Array.isArray(raw)) {
        throw new SupplierUnavailableError('invalid_response', 'The flight results could not be read.');
      }
      // One unreadable offer is counted and skipped. It never stops the readable offers from being shown.
      const offers = [];
      const dropped = { invalidCurrency: 0, invalidPrice: 0, malformed: 0, codes: [] };
      for (const item of raw) {
        const reason = droppedReason(item);
        if (reason === null) {
          offers.push(item);
          continue;
        }
        dropped[reason.kind] += 1;
        if (reason.code) dropped.codes.push(reason.code);
      }
      return { offers, excluded: mergeExcluded(excludedFrom(body.excluded), dropped) };
    },
  };
}

// Runs a validated search through the shared search service. Validation happens inside runFlightSearch,
// so an invalid search never leaves the page.
export function searchFlights(input, today, options = {}) {
  const supplier = createSearchSupplier({
    input,
    endpoint: options.endpoint ?? config.FLIGHT_SEARCH_ENDPOINT ?? null,
    mode: options.mode ?? config.FLIGHT_SEARCH_MODE ?? 'sandbox',
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  return runFlightSearch(input, today, supplier);
}
