// Travel-document rules. Nothing here assumes which documents a route requires. The
// requirement is data, and any route without a confirmed entry is 'unconfirmed'.
// Document numbers are sensitive: they are validated in memory, never logged, and
// are not persisted until the storage and retention review is complete (see
// docs/10 and the bookings schema).

import { isKnownCountry } from './phone.ts';
import { isRealCalendarDate } from './dates.ts';

export type DocumentRequirement = 'required' | 'not_required' | 'unconfirmed';

// Confirmed entries only. Add a route here only when the requirement is verified.
// Empty on purpose: no route has been verified yet.
const CONFIRMED_RULES: Readonly<Record<string, DocumentRequirement>> = {};

export function documentRequirementFor(origin: string, destination: string): DocumentRequirement {
  return CONFIRMED_RULES[`${origin}-${destination}`] ?? 'unconfirmed';
}

export interface TravelDocument {
  readonly number: string;
  readonly issuingCountry: string; // ISO alpha-2
  readonly expiryDate: string; // YYYY-MM-DD
}

export interface DocumentValidation {
  readonly valid: boolean;
  readonly errors: Readonly<Record<string, string>>;
}

const NUMBER_PATTERN = /^[A-Z0-9]{5,20}$/;

export function validateTravelDocument(document: TravelDocument, todayUtc: string): DocumentValidation {
  const errors: Record<string, string> = {};
  const number = document.number.trim().toUpperCase();
  if (!NUMBER_PATTERN.test(number)) {
    errors.number = 'Enter the document number as printed: 5 to 20 letters or digits.';
  }
  if (!isKnownCountry(document.issuingCountry)) {
    errors.issuingCountry = 'Choose the country that issued the document.';
  }
  if (!isRealCalendarDate(document.expiryDate)) {
    errors.expiryDate = 'Enter a valid expiry date.';
  } else if (document.expiryDate <= todayUtc) {
    errors.expiryDate = 'This document has expired.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// Shows only the last three characters, for screens and logs.
export function maskDocumentNumber(number: string): string {
  const clean = number.replace(/\s/g, '');
  return clean.length <= 3 ? '•••' : `•••${clean.slice(-3)}`;
}
