// Search input validation and mapping to the supplier request. Runs before any
// supplier is called, so invalid searches never reach a provider.

import { isCurrencyCode, type CurrencyCode } from '../../core/src/money.ts';
import type { CabinClass, SearchLeg, SearchRequest } from './supplier.ts';

export type TripType = 'one_way' | 'round_trip' | 'multi_city';

export const CABIN_CLASSES: readonly CabinClass[] = ['economy', 'premium_economy', 'business', 'first'];

export const CABIN_LABELS: Record<CabinClass, string> = {
  economy: 'Economy',
  premium_economy: 'Premium Economy',
  business: 'Business',
  first: 'First Class',
};

export const MAX_TRAVELLERS = 9;
export const MIN_LEGS = 2;
export const MAX_LEGS = 6;

export interface PassengerMix {
  readonly adults: number;
  readonly children: number; // aged 2 to 11 on travel date
  readonly infants: number; // under 2 on travel date
}

export interface FlightSearchInput {
  readonly tripType: TripType;
  // One-way and return: the journey. Absent for multi-city.
  readonly origin?: string;
  readonly destination?: string;
  readonly departureDate?: string;
  readonly returnDate?: string;
  // Multi-city only: the journeys in travel order. Absent otherwise.
  readonly legs?: readonly SearchLeg[];
  readonly passengers: PassengerMix;
  readonly cabin: CabinClass;
  readonly displayCurrency: CurrencyCode;
}

export interface SearchValidation {
  readonly valid: boolean;
  // Keyed by field, so the form can show each message beside its field.
  // Multi-city leg fields use keys such as "legs.1.departureDate".
  readonly errors: Readonly<Record<string, string>>;
}

const IATA_PATTERN = /^[A-Z]{3}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isRealCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function validatePassengerMix(mix: PassengerMix): Record<string, string> {
  const errors: Record<string, string> = {};
  const counts = [mix.adults, mix.children, mix.infants];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    errors.passengers = 'Passenger counts must be whole numbers, zero or more.';
    return errors;
  }
  if (mix.adults < 1) {
    errors.passengers = 'At least one adult is required.';
  } else if (mix.adults + mix.children + mix.infants > MAX_TRAVELLERS) {
    errors.passengers = `You can search for up to ${MAX_TRAVELLERS} travellers.`;
  } else if (mix.infants > mix.adults) {
    errors.passengers = 'Each infant needs an adult travelling with them.';
  }
  return errors;
}

// Checks one journey. Shared by the one-way and return checks and by every multi-city leg.
function journeyErrors(
  origin: string | undefined,
  destination: string | undefined,
  departureDate: string | undefined,
  today: string,
): { origin?: string; destination?: string; departureDate?: string } {
  const errors: { origin?: string; destination?: string; departureDate?: string } = {};
  if (!IATA_PATTERN.test(origin ?? '')) errors.origin = 'Choose a departure airport.';
  if (!IATA_PATTERN.test(destination ?? '')) errors.destination = 'Choose a destination airport.';
  if (IATA_PATTERN.test(origin ?? '') && origin === destination) {
    errors.destination = 'Destination must be different from departure.';
  }
  if (!isRealCalendarDate(departureDate ?? '')) {
    errors.departureDate = 'Enter a valid departure date.';
  } else if ((departureDate as string) < today) {
    errors.departureDate = 'Departure date cannot be in the past.';
  }
  return errors;
}

function legErrors(legs: readonly SearchLeg[] | undefined, today: string): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!Array.isArray(legs)) {
    errors.legs = 'Add at least two journeys for a multi-city search.';
    return errors;
  }
  if (legs.length < MIN_LEGS) {
    errors.legs = 'Add at least two journeys for a multi-city search.';
  } else if (legs.length > MAX_LEGS) {
    errors.legs = `A multi-city search can have up to ${MAX_LEGS} journeys.`;
  }

  let previousDate: string | undefined;
  legs.forEach((leg, index) => {
    const found = journeyErrors(leg?.origin, leg?.destination, leg?.departureDate, today);
    if (found.origin) errors[`legs.${index}.origin`] = found.origin;
    if (found.destination) errors[`legs.${index}.destination`] = found.destination;
    if (found.departureDate) errors[`legs.${index}.departureDate`] = found.departureDate;
    else if (previousDate !== undefined && (leg.departureDate as string) < previousDate) {
      errors[`legs.${index}.departureDate`] = 'Each journey must be on or after the one before it.';
    }
    if (isRealCalendarDate(leg?.departureDate ?? '')) previousDate = leg.departureDate;
  });
  return errors;
}

export function validateSearch(input: FlightSearchInput, today: string): SearchValidation {
  const errors: Record<string, string> = {};

  if (input.tripType === 'multi_city') {
    Object.assign(errors, legErrors(input.legs, today));
    if (input.returnDate !== undefined) errors.returnDate = 'Multi-city journeys do not have a return date.';
  } else {
    const journey = journeyErrors(input.origin, input.destination, input.departureDate, today);
    Object.assign(errors, journey);

    if (input.tripType === 'round_trip') {
      if (!input.returnDate || !isRealCalendarDate(input.returnDate)) {
        errors.returnDate = 'Enter a valid return date.';
      } else if (isRealCalendarDate(input.departureDate ?? '') && input.returnDate < (input.departureDate as string)) {
        errors.returnDate = 'Return date cannot be before departure.';
      }
    } else if (input.returnDate !== undefined) {
      errors.returnDate = 'One-way journeys do not have a return date.';
    }
    if (input.legs !== undefined) errors.legs = 'Only multi-city searches list journeys.';
  }

  Object.assign(errors, validatePassengerMix(input.passengers));

  if (!CABIN_CLASSES.includes(input.cabin)) errors.cabin = 'Choose a cabin class.';
  if (!isCurrencyCode(input.displayCurrency)) errors.displayCurrency = 'Choose a supported currency.';

  return { valid: Object.keys(errors).length === 0, errors };
}

// Maps a validated search to the supplier request. Throws if the input is invalid,
// so an unvalidated search can never reach a supplier.
export function toSupplierRequest(input: FlightSearchInput, today: string): SearchRequest {
  const result = validateSearch(input, today);
  if (!result.valid) {
    throw new RangeError(`Invalid search: ${Object.keys(result.errors).join(', ')}`);
  }
  const passengers = {
    passengers: input.passengers.adults + input.passengers.children,
    adults: input.passengers.adults,
    children: input.passengers.children,
    infants: input.passengers.infants,
    cabin: input.cabin,
    displayCurrency: input.displayCurrency,
  };

  if (input.tripType === 'multi_city') {
    const legs: SearchLeg[] = (input.legs ?? []).map((leg) => ({
      origin: leg.origin,
      destination: leg.destination,
      departureDate: leg.departureDate,
    }));
    return {
      origin: legs[0].origin,
      destination: legs[0].destination,
      departureDate: legs[0].departureDate,
      legs,
      ...passengers,
    };
  }

  return {
    origin: input.origin as string,
    destination: input.destination as string,
    departureDate: input.departureDate as string,
    ...(input.tripType === 'round_trip' && input.returnDate ? { returnDate: input.returnDate } : {}),
    ...passengers,
  };
}
