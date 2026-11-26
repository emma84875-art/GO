// Pure search logic for the web app: URL parameters <-> search input, validation through the SAME code the
// server uses (packages/flights, vendored), and the result options (sort and filters). No DOM here, so it
// is unit tested directly.

import { validateSearch, CABIN_CLASSES, CABIN_LABELS } from '../vendor/packages/flights/src/search.js';
import { findAirport } from '../vendor/packages/flights/src/airports.js';

export { CABIN_CLASSES, CABIN_LABELS };

// Every search asks for NGN. GO does not convert prices, so there is no currency choice to offer. Each fare is
// shown in the currency the airline sells it in, and the page says so.
export const DISPLAY_CURRENCY = 'NGN';
export const SORT_OPTIONS = { price: 'Lowest price', duration: 'Shortest journey', departure: 'Earliest departure' };
export const STOPS_OPTIONS = { any: 'Any number of stops', nonstop: 'Nonstop only', max_one: 'Up to one stop' };
// Minutes after local midnight, inclusive. Departure time is in the origin airport's local time.
export const DEPARTURE_WINDOWS = {
  any: { label: 'Any time', range: null },
  morning: { label: 'Morning (00:00 to 11:59)', range: [0, 719] },
  afternoon: { label: 'Afternoon (12:00 to 17:59)', range: [720, 1079] },
  evening: { label: 'Evening (18:00 to 23:59)', range: [1080, 1439] },
};

export const SEARCH_KEYS = ['trip', 'from', 'to', 'depart', 'return', 'legs', 'adults', 'children', 'infants', 'cabin', 'currency'];
// Multi-city journeys in the URL: "LOS-LHR-2026-12-01,LHR-DXB-2026-12-05". The date keeps its own dashes,
// so the first two parts are the airports and the rest is the date. Bad values reach the validator as they are.
export const MAX_URL_LEGS = 12;
export const OPTION_KEYS = ['sort', 'stops', 'dep', 'airline', 'bags'];

// The calendar date in Lagos, the home market. Dates are compared as YYYY-MM-DD strings.
export function todayInLagos(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now);
  const pick = (type) => parts.find((part) => part.type === type).value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

// Whole numbers only. Anything else becomes NaN, which the shared validator refuses with a clear message.
function wholeNumber(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

export function parseLegsParam(value = '') {
  if (!value) return [];
  return value.split(',').slice(0, MAX_URL_LEGS).map((part) => {
    const pieces = part.split('-');
    return {
      origin: (pieces[0] ?? '').toUpperCase(),
      destination: (pieces[1] ?? '').toUpperCase(),
      departureDate: pieces.slice(2).join('-'),
    };
  });
}

export function legsParam(legs = []) {
  return legs.map((leg) => `${leg.origin}-${leg.destination}-${leg.departureDate}`).join(',');
}

export function inputFromParams(params = {}) {
  const tripType = params.trip === 'round_trip' || params.trip === 'multi_city' ? params.trip : 'one_way';
  const passengers = {
    adults: wholeNumber(params.adults, 1),
    children: wholeNumber(params.children, 0),
    infants: wholeNumber(params.infants, 0),
  };
  const cabin = params.cabin ?? 'economy';
  const displayCurrency = DISPLAY_CURRENCY;
  if (tripType === 'multi_city') {
    return { tripType, legs: parseLegsParam(params.legs), passengers, cabin, displayCurrency };
  }
  return {
    tripType,
    origin: (params.from ?? '').toUpperCase(),
    destination: (params.to ?? '').toUpperCase(),
    departureDate: params.depart ?? '',
    ...(tripType === 'round_trip' ? { returnDate: params.return ?? '' } : {}),
    passengers,
    cabin,
    displayCurrency,
  };
}

export function paramsFromInput(input) {
  const params = new URLSearchParams();
  params.set('trip', input.tripType);
  if (input.tripType === 'multi_city') {
    params.set('legs', legsParam(input.legs ?? []));
  } else {
    params.set('from', input.origin);
    params.set('to', input.destination);
    params.set('depart', input.departureDate);
  }
  if (input.tripType === 'round_trip') params.set('return', input.returnDate ?? '');
  params.set('adults', String(input.passengers.adults));
  params.set('children', String(input.passengers.children));
  params.set('infants', String(input.passengers.infants));
  params.set('cabin', input.cabin);
  params.set('currency', input.displayCurrency);
  return params;
}

export function validateInput(input, today) {
  return validateSearch(input, today).errors;
}

// Result options come from the URL, so a refresh or a shared link keeps the same sort and filters.
export function optionsFromParams(params = {}) {
  return {
    sort: Object.hasOwn(SORT_OPTIONS, params.sort) ? params.sort : 'price',
    stops: Object.hasOwn(STOPS_OPTIONS, params.stops) ? params.stops : 'any',
    departure: Object.hasOwn(DEPARTURE_WINDOWS, params.dep) ? params.dep : 'any',
    airline: /^[A-Z0-9]{2}$/.test((params.airline ?? '').toUpperCase()) ? params.airline.toUpperCase() : '',
    checkedBags: params.bags === '1',
  };
}

export function offerFiltersFrom(options) {
  const filters = {};
  if (options.stops === 'nonstop' || options.stops === 'max_one') filters.stops = options.stops;
  if (options.airline) filters.airlines = [options.airline];
  const window = DEPARTURE_WINDOWS[options.departure]?.range;
  if (window) {
    filters.departureFromMinutes = window[0];
    filters.departureToMinutes = window[1];
  }
  if (options.checkedBags) filters.requireCheckedBags = true;
  return filters;
}

// Builds the hash for the search page with some values changed. Empty and false values are left out.
export function searchHash(params, changes = {}) {
  const next = new URLSearchParams();
  for (const key of [...SEARCH_KEYS, ...OPTION_KEYS]) {
    const value = Object.hasOwn(changes, key) ? changes[key] : params[key];
    if (value !== undefined && value !== '' && value !== false && value !== null) next.set(key, String(value));
  }
  return `#/search?${next.toString()}`;
}

export function airportLabel(iata) {
  const airport = findAirport(iata);
  return airport ? `${airport.city} (${airport.iata})` : iata;
}

export function hasDates(params) {
  if (params.trip === 'multi_city') return Boolean(params.legs);
  return Boolean(params.depart);
}
