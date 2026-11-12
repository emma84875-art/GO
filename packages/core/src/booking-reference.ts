// Booking references. 6 characters from a 32-symbol alphabet that drops the easily
// confused I, O, 0 and 1. The alphabet size divides 256, so every byte maps evenly
// and there is no modulo bias. Uniqueness is enforced by the database, not here.

import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REFERENCE_LENGTH = 6;
export const REFERENCE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

export function newBookingReference(bytes: (n: number) => Uint8Array = randomBytes): string {
  const buffer = bytes(REFERENCE_LENGTH);
  let reference = '';
  for (const byte of buffer) reference += ALPHABET[byte % ALPHABET.length];
  return reference;
}
