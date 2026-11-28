// Passenger personal data, encrypted before it is stored (Phase 19.2, docs/26, section 6).
//
// Only the two fields the owner named are sealed here: first and last name, and date of birth. Nationality and any other
// field are not part of this module, so they are not stored by it. Each value is encrypted with AES-256-GCM under a key
// from the caller's keyring (packages/security FieldCrypto). The key never enters the database. Each ciphertext is bound
// to its booking, passenger position and field through the authenticated data, so a value copied to another row or field
// does not decrypt.
//
// This module is a primitive. No code path stores passenger data yet, because booking creation is not connected
// (docs/26, section 5). Live use requires the table change in docs/26, section 6.

import { FieldCrypto } from '../../security/src/field-crypto.ts';

export interface PassengerDetails {
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string; // YYYY-MM-DD
}

export interface SealedPassenger {
  readonly firstNameSealed: string;
  readonly lastNameSealed: string;
  readonly dateOfBirthSealed: string;
}

const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} '.-]{0,99}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function checkDetails(details: PassengerDetails): void {
  if (!NAME_PATTERN.test(details.firstName.trim()) || !NAME_PATTERN.test(details.lastName.trim())) {
    throw new RangeError('passenger names must be 1 to 100 letters, spaces, apostrophes, periods or hyphens');
  }
  // The round trip rejects dates that JavaScript would roll over, such as 1990-02-31.
  const parsed = DATE_PATTERN.test(details.dateOfBirth) ? new Date(`${details.dateOfBirth}T00:00:00Z`) : null;
  if (parsed === null || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== details.dateOfBirth) {
    throw new RangeError('date of birth must be a real date in YYYY-MM-DD form');
  }
}

export class PassengerVault {
  readonly #crypto: FieldCrypto;

  constructor(crypto: FieldCrypto) {
    this.#crypto = crypto;
  }

  seal(bookingId: string, passengerIndex: number, details: PassengerDetails): SealedPassenger {
    checkDetails(details);
    const base = `passenger:${bookingId}:${passengerIndex}`;
    return {
      firstNameSealed: this.#crypto.encrypt(details.firstName.trim(), `${base}:first_name`),
      lastNameSealed: this.#crypto.encrypt(details.lastName.trim(), `${base}:last_name`),
      dateOfBirthSealed: this.#crypto.encrypt(details.dateOfBirth, `${base}:date_of_birth`),
    };
  }

  open(bookingId: string, passengerIndex: number, sealed: SealedPassenger): PassengerDetails {
    const base = `passenger:${bookingId}:${passengerIndex}`;
    return {
      firstName: this.#crypto.decrypt(sealed.firstNameSealed, `${base}:first_name`),
      lastName: this.#crypto.decrypt(sealed.lastNameSealed, `${base}:last_name`),
      dateOfBirth: this.#crypto.decrypt(sealed.dateOfBirthSealed, `${base}:date_of_birth`),
    };
  }
}
