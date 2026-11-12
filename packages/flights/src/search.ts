// Search input validation and mapping to the supplier request. Runs before any
// supplier is called, so invalid searches never reach a provider.

import { isCurrencyCode, type CurrencyCode } from '../../core/src/money.ts';
import type { CabinClass, SearchRequest } from './supplier.ts';

export type TripType = 'one_way' | 'round_trip';

export const CABIN_CLASSES: readonly CabinClass[] = ['economy', 'premium_economy', 'business', 'first'];

export const CABIN_LABELS: Record<CabinClass, string> = {
  economy: 'Economy',
  premium_economy: 'Premium Economy',
  business: 'Business',
  first: 'First Class',
};

export const MAX_TRAVELLERS = 9;

export interface PassengerMix {
  readonly adults: number;
  readonly children: number; // aged 2 to 11 on travel date
  readonly infants: number; // under 2 on travel date
}

export interface FlightSearchInput {
  readonly tripType: TripType;
  readonly origin: string;
  readonly destination: string;
  readonly departureDate: string;
  readonly returnDate?: string;
  readonly passengers: PassengerMix;
  readonly cabin: CabinClass;
  readonly displayCurrency: CurrencyCode;
}

export interface SearchValidation {
  readonly valid: boolean;
  // Keyed by field, so the form can show each message beside its field.
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

export function validateSearch(input: FlightSearchInput, today: string): SearchValidation {
  const errors: Record<string, string> = {};

  if (!IATA_PATTERN.test(input.origin)) errors.origin = 'Choose a departure airport.';
  if (!IATA_PATTERN.test(input.destination)) errors.destination = 'Choose a destination airport.';
  if (IATA_PATTERN.test(input.origin) && input.origin === input.destination) {
    errors.destination = 'Destination must be different from departure.';
  }

  if (!isRealCalendarDate(input.departureDate)) {
    errors.departureDate = 'Enter a valid departure date.';
  } else if (input.departureDate < today) {
    errors.departureDate = 'Departure date cannot be in the past.';
  }

  if (input.tripType === 'round_trip') {
    if (!input.returnDate || !isRealCalendarDate(input.returnDate)) {
      errors.returnDate = 'Enter a valid return date.';
    } else if (isRealCalendarDate(input.departureDate) && input.returnDate < input.departureDate) {
      errors.returnDate = 'Return date cannot be before departure.';
    }
  } else if (input.returnDate !== undefined) {
    errors.returnDate = 'One-way journeys do not have a return date.';
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
  return {
    origin: input.origin,
    destination: input.destination,
    departureDate: input.departureDate,
    ...(input.tripType === 'round_trip' && input.returnDate ? { returnDate: input.returnDate } : {}),
    passengers: input.passengers.adults + input.passengers.children,
    infants: input.passengers.infants,
    cabin: input.cabin,
    displayCurrency: input.displayCurrency,
  };
}
