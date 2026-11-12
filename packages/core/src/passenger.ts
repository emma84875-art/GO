// Passenger detail validation. Rules here are the platform's baseline. Airline and
// destination-specific rules (document validity, name formats, age bands) are data,
// added per supplier and per route later.

export type PassengerType = 'adult' | 'child' | 'infant';

export interface PassengerInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string; // YYYY-MM-DD
  readonly nationality: string; // ISO 3166-1 alpha-2, e.g. "NG"
}

export interface PassengerValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly passengerType?: PassengerType;
}

// Letters from any script, plus spaces, hyphens, apostrophes and full stops.
const NAME_PATTERN = /^[\p{L}][\p{L}\s'.-]*[\p{L}]$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const NATIONALITY_PATTERN = /^[A-Z]{2}$/;

export function ageOn(dateOfBirth: string, onDate: string): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number);
  const [y, m, d] = onDate.split('-').map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}

export function passengerTypeFor(age: number): PassengerType {
  if (age < 2) return 'infant';
  if (age < 12) return 'child';
  return 'adult';
}

function isRealCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function validatePassenger(input: PassengerInput, travelDate: string): PassengerValidation {
  const errors: string[] = [];
  const first = input.firstName.trim();
  const last = input.lastName.trim();

  if (first.length < 2 || first.length > 50) errors.push('First name must be between 2 and 50 characters.');
  else if (!NAME_PATTERN.test(first)) errors.push('First name contains characters that are not allowed.');

  if (last.length < 2 || last.length > 50) errors.push('Last name must be between 2 and 50 characters.');
  else if (!NAME_PATTERN.test(last)) errors.push('Last name contains characters that are not allowed.');

  if (!isRealCalendarDate(input.dateOfBirth)) {
    errors.push('Date of birth must be a real date in YYYY-MM-DD format.');
  } else if (input.dateOfBirth > travelDate) {
    errors.push('Date of birth cannot be after the travel date.');
  } else if (input.dateOfBirth < '1900-01-01') {
    errors.push('Date of birth is not plausible.');
  }

  if (!NATIONALITY_PATTERN.test(input.nationality)) {
    errors.push('Nationality must be a two-letter country code.');
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    errors: [],
    passengerType: passengerTypeFor(ageOn(input.dateOfBirth, travelDate)),
  };
}
