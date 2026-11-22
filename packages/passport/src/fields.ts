// Passport field validation. Only 'passport' is accepted until a supplier confirms the
// other document types. The number checks reuse the core travel-document rules. Error
// messages never include the number, the name or any other personal value.

import { validateTravelDocument } from '../../core/src/travel-document.ts';
import { isRealCalendarDate } from '../../core/src/dates.ts';

export interface PassportInput {
  readonly documentType: string;
  readonly number: string;
  readonly issuingCountry: string; // ISO alpha-2
  readonly expiresOn: string; // YYYY-MM-DD
}

export interface PassportValidation {
  readonly valid: boolean;
  readonly errors: Readonly<Record<string, string>>;
  readonly normalised: PassportInput | null;
}

export function validatePassport(
  input: PassportInput,
  travelDateUtc: string,
  todayUtc: string,
): PassportValidation {
  if (!isRealCalendarDate(travelDateUtc)) {
    throw new TypeError('travelDateUtc must be a real calendar date (YYYY-MM-DD)');
  }
  if (!isRealCalendarDate(todayUtc)) {
    throw new TypeError('todayUtc must be a real calendar date (YYYY-MM-DD)');
  }
  if (typeof input !== 'object' || input === null) {
    return refuse({ passport: 'Enter the passport details.' });
  }

  const errors: Record<string, string> = {};
  if (input.documentType !== 'passport') {
    errors.documentType = 'Only passport details are accepted for this booking.';
  }

  const number = typeof input.number === 'string' ? input.number.trim().toUpperCase() : '';
  const issuingCountry =
    typeof input.issuingCountry === 'string' ? input.issuingCountry.trim().toUpperCase() : '';
  const expiresOn = typeof input.expiresOn === 'string' ? input.expiresOn.trim() : '';

  const document = validateTravelDocument(
    { number, issuingCountry, expiryDate: expiresOn },
    todayUtc,
  );
  if (document.errors.number !== undefined) errors.number = document.errors.number;
  if (document.errors.issuingCountry !== undefined) errors.issuingCountry = document.errors.issuingCountry;
  if (document.errors.expiryDate !== undefined) errors.expiresOn = document.errors.expiryDate;

  // Travel rule: the passport must still be valid on the travel date, not just today.
  if (errors.expiresOn === undefined && expiresOn <= travelDateUtc) {
    errors.expiresOn = 'This passport expires before the travel date. Renew it before booking.';
  }

  if (Object.keys(errors).length > 0) {
    return refuse(errors);
  }
  return {
    valid: true,
    errors: {},
    normalised: { documentType: 'passport', number, issuingCountry, expiresOn },
  };
}

function refuse(errors: Record<string, string>): PassportValidation {
  return { valid: false, errors, normalised: null };
}
