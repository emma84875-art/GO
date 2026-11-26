// Strict parsing of a search request body from the network. It checks the shape only: which fields
// exist, their types and their sizes. The meaning (airports, dates, passenger rules) is checked by
// validateSearch, which runs next. Nothing from the input is echoed back in an error message.

import type { CabinClass, SearchLeg } from './supplier.ts';
import { CABIN_CLASSES, MAX_LEGS, type FlightSearchInput, type TripType } from './search.ts';
import type { CurrencyCode } from '../../core/src/money.ts';

const TRIP_TYPES: readonly TripType[] = ['one_way', 'round_trip', 'multi_city'];
const TOP_LEVEL_FIELDS = new Set(['tripType', 'origin', 'destination', 'departureDate', 'returnDate', 'legs', 'passengers', 'cabin', 'displayCurrency']);
const LEG_FIELDS = new Set(['origin', 'destination', 'departureDate']);
const PASSENGER_FIELDS = new Set(['adults', 'children', 'infants']);
const AIRPORT_MAX = 3;
const DATE_MAX = 10;
const CURRENCY_MAX = 3;
const CABIN_MAX = 32;
// Refuse absurd lists early. validateSearch then gives the user-facing count message.
const LEG_LIST_MAX = MAX_LEGS * 4;

export type ParsedSearch = { readonly ok: true; readonly input: FlightSearchInput } | { readonly ok: false; readonly errors: Record<string, string> };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

function wholeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

export function parseSearchInput(raw: unknown): ParsedSearch {
  if (!isPlainObject(raw)) return { ok: false, errors: { body: 'Send a JSON object with the search details.' } };

  const errors: Record<string, string> = {};
  // A fixed key, never the name the client sent, so input is not reflected back.
  if (Object.keys(raw).some((key) => !TOP_LEVEL_FIELDS.has(key))) {
    errors.unknownField = 'The request has a field that is not part of a flight search.';
  }

  const tripType = raw.tripType;
  if (!TRIP_TYPES.includes(tripType as TripType)) {
    errors.tripType = 'Choose one-way, return or multi-city.';
    return { ok: false, errors };
  }
  const trip = tripType as TripType;

  // Passengers: adults is required, the others default to zero.
  let passengers = { adults: Number.NaN, children: 0, infants: 0 };
  if (!isPlainObject(raw.passengers)) {
    errors.passengers = 'Add the number of travellers.';
  } else {
    if (Object.keys(raw.passengers).some((key) => !PASSENGER_FIELDS.has(key))) {
      errors.passengers = 'Passenger counts are adults, children and infants only.';
    }
    const adults = wholeCount(raw.passengers.adults);
    const children = raw.passengers.children === undefined ? 0 : wholeCount(raw.passengers.children);
    const infants = raw.passengers.infants === undefined ? 0 : wholeCount(raw.passengers.infants);
    if (adults === undefined || children === undefined || infants === undefined) {
      errors.passengers ??= 'Passenger counts must be whole numbers, zero or more.';
    } else {
      passengers = { adults, children, infants };
    }
  }

  const cabin = boundedText(raw.cabin, CABIN_MAX);
  if (cabin === undefined || !CABIN_CLASSES.includes(cabin as CabinClass)) errors.cabin = 'Choose a cabin class.';
  const currency = boundedText(raw.displayCurrency, CURRENCY_MAX);
  if (currency === undefined) errors.displayCurrency = 'Choose a supported currency.';

  let input: FlightSearchInput | undefined;
  if (trip === 'multi_city') {
    if (raw.origin !== undefined || raw.destination !== undefined || raw.departureDate !== undefined || raw.returnDate !== undefined) {
      errors.legs ??= 'Multi-city searches list each journey as a leg.';
    }
    const legs = parseLegs(raw.legs, errors);
    if (legs !== undefined) {
      input = { tripType: 'multi_city', legs, passengers, cabin: cabin as CabinClass, displayCurrency: currency as CurrencyCode };
    }
  } else {
    if (raw.legs !== undefined) errors.legs = 'Only multi-city searches list journeys.';
    const origin = boundedText(raw.origin, AIRPORT_MAX);
    const destination = boundedText(raw.destination, AIRPORT_MAX);
    const departureDate = boundedText(raw.departureDate, DATE_MAX);
    const returnDate = trip === 'round_trip' ? boundedText(raw.returnDate, DATE_MAX) : undefined;
    if (origin === undefined) errors.origin = 'Choose a departure airport.';
    if (destination === undefined) errors.destination = 'Choose a destination airport.';
    if (departureDate === undefined) errors.departureDate = 'Enter a valid departure date.';
    if (trip === 'round_trip' && returnDate === undefined) errors.returnDate = 'Enter a valid return date.';
    if (trip === 'one_way' && raw.returnDate !== undefined) errors.returnDate = 'One-way journeys do not have a return date.';
    if (origin !== undefined && destination !== undefined && departureDate !== undefined && (trip !== 'round_trip' || returnDate !== undefined)) {
      input = {
        tripType: trip,
        origin,
        destination,
        departureDate,
        ...(trip === 'round_trip' ? { returnDate: returnDate as string } : {}),
        passengers,
        cabin: cabin as CabinClass,
        displayCurrency: currency as CurrencyCode,
      };
    }
  }

  if (Object.keys(errors).length > 0 || input === undefined) {
    return { ok: false, errors };
  }
  return { ok: true, input };
}

// Parses the legs list. Each leg may only contain the three journey fields, and its values are bounded.
function parseLegs(value: unknown, errors: Record<string, string>): SearchLeg[] | undefined {
  if (!Array.isArray(value)) {
    errors.legs = 'Add at least two journeys for a multi-city search.';
    return undefined;
  }
  if (value.length > LEG_LIST_MAX) {
    errors.legs = `A multi-city search can have up to ${MAX_LEGS} journeys.`;
    return undefined;
  }
  const legs: SearchLeg[] = [];
  let valid = true;
  value.forEach((item, index) => {
    if (!isPlainObject(item)) {
      errors[`legs.${index}`] = 'Each journey needs an origin, destination and date.';
      valid = false;
      return;
    }
    for (const key of Object.keys(item)) {
      if (!LEG_FIELDS.has(key)) {
        errors[`legs.${index}`] = 'Each journey has only an origin, destination and date.';
        valid = false;
      }
    }
    const origin = boundedText(item.origin, AIRPORT_MAX);
    const destination = boundedText(item.destination, AIRPORT_MAX);
    const departureDate = boundedText(item.departureDate, DATE_MAX);
    if (origin === undefined || destination === undefined || departureDate === undefined) {
      errors[`legs.${index}`] ??= 'Each journey needs an origin, destination and date.';
      valid = false;
      return;
    }
    legs.push({ origin, destination, departureDate });
  });
  return valid ? legs : undefined;
}

export const SEARCH_INPUT_LIMITS = Object.freeze({ airport: AIRPORT_MAX, date: DATE_MAX, legs: LEG_LIST_MAX });
