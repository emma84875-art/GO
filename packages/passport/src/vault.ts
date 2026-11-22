// Passport vault. Holds passport details only as ciphertext, releases them for one
// purpose (supplier orders), keeps an access log without personal data, and purges
// records once their retention period ends.
//
// Storage is in memory for now. Durable storage waits for the retention and storage
// review (docs/18-security-audit.md). The caller injects the cipher and the retention
// period; this module reads no environment and has no default retention.

import { randomUUID } from 'node:crypto';

import type { PassportInput } from './fields.ts';

export interface PassportCipher {
  encrypt(plaintext: string, aad: string): string;
  decrypt(token: string, aad: string): string;
}

export interface StoreInput {
  readonly bookingId: string;
  readonly passengerIndex: number;
  readonly passport: PassportInput;
}

export interface AccessLogEntry {
  readonly at: string;
  readonly ref: string;
  readonly purpose: 'supplier_order';
  readonly actorLabel: string;
}

export interface PurgeLogEntry {
  readonly at: string;
  readonly ref: string;
}

interface StoredRecord {
  numberCipher: string;
  detailsCipher: string;
  readonly purgeAtUtc: string;
  readonly purgeAtMs: number;
}

interface StoredDetails {
  readonly bookingId: string;
  readonly passengerIndex: number;
  readonly documentType: string;
  readonly issuingCountry: string;
  readonly expiresOn: string;
}

const DAY_MS = 86_400_000;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z)?$/;
const ACTOR_PATTERN = /^[a-z0-9_.:-]{1,64}$/;

export class PassportVault {
  readonly #cipher: PassportCipher;
  readonly #retentionDays: number;
  readonly #records = new Map<string, StoredRecord>();
  readonly #access: AccessLogEntry[] = [];
  readonly #purges: PurgeLogEntry[] = [];

  constructor(cipher: PassportCipher, retentionDays: number) {
    if (
      typeof cipher !== 'object' ||
      cipher === null ||
      typeof cipher.encrypt !== 'function' ||
      typeof cipher.decrypt !== 'function'
    ) {
      throw new TypeError('a cipher with encrypt and decrypt is required');
    }
    if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
      throw new TypeError('retentionDays must be a positive integer');
    }
    this.#cipher = cipher;
    this.#retentionDays = retentionDays;
  }

  store(input: StoreInput, nowUtc: string): { ref: string } {
    const nowMs = parseUtc(nowUtc, 'nowUtc');
    if (typeof input.bookingId !== 'string' || input.bookingId.length === 0 || input.bookingId.length > 64) {
      throw new TypeError('bookingId must be a non-empty string of at most 64 characters');
    }
    if (!Number.isSafeInteger(input.passengerIndex) || input.passengerIndex < 0) {
      throw new TypeError('passengerIndex must be a non-negative integer');
    }
    const passport = input.passport;
    if (passport.documentType !== 'passport') {
      throw new TypeError('only passport details can be stored');
    }
    if (typeof passport.number !== 'string' || passport.number.length === 0) {
      throw new TypeError('passport number is required');
    }

    const ref = randomUUID();
    const aad = `passport:${ref}`;
    const details: StoredDetails = {
      bookingId: input.bookingId,
      passengerIndex: input.passengerIndex,
      documentType: passport.documentType,
      issuingCountry: passport.issuingCountry,
      expiresOn: passport.expiresOn,
    };
    const purgeAtMs = nowMs + this.#retentionDays * DAY_MS;
    this.#records.set(ref, {
      numberCipher: this.#cipher.encrypt(passport.number, aad),
      detailsCipher: this.#cipher.encrypt(JSON.stringify(details), aad),
      purgeAtUtc: new Date(purgeAtMs).toISOString(),
      purgeAtMs,
    });
    return { ref };
  }

  read(ref: string, purpose: 'supplier_order', actorLabel: string, nowUtc: string): PassportInput {
    if (purpose !== 'supplier_order') {
      throw new Error('purpose_not_allowed');
    }
    checkActor(actorLabel);
    const nowMs = parseUtc(nowUtc, 'nowUtc');
    const record = typeof ref === 'string' ? this.#records.get(ref) : undefined;
    if (record === undefined || record.purgeAtMs <= nowMs) {
      throw new Error('not_found');
    }
    this.#access.push({ at: nowUtc, ref, purpose, actorLabel });

    const aad = `passport:${ref}`;
    const number = this.#cipher.decrypt(record.numberCipher, aad);
    const details = JSON.parse(this.#cipher.decrypt(record.detailsCipher, aad)) as StoredDetails;
    return {
      documentType: details.documentType,
      number,
      issuingCountry: details.issuingCountry,
      expiresOn: details.expiresOn,
    };
  }

  purgeDue(nowUtc: string): number {
    const nowMs = parseUtc(nowUtc, 'nowUtc');
    let count = 0;
    for (const [ref, record] of this.#records) {
      if (record.purgeAtMs <= nowMs) {
        record.numberCipher = '';
        record.detailsCipher = '';
        this.#records.delete(ref);
        this.#purges.push({ at: nowUtc, ref });
        count += 1;
      }
    }
    return count;
  }

  accessLog(): readonly AccessLogEntry[] {
    return this.#access.map((entry) => ({ ...entry }));
  }

  purgeLog(): readonly PurgeLogEntry[] {
    return this.#purges.map((entry) => ({ ...entry }));
  }

  // Test and audit hook. Returns only the stored ciphertext strings, so a test can
  // confirm that no plaintext personal data is held in the vault's state.
  dumpForAudit(): readonly string[] {
    const out: string[] = [];
    for (const record of this.#records.values()) {
      out.push(record.numberCipher, record.detailsCipher);
    }
    return out;
  }
}

// The only fields that may be written to logs. The number is deliberately absent.
export function passportLogFields(passport: PassportInput): {
  documentType: string;
  issuingCountry: string;
  expiresOn: string;
} {
  return {
    documentType: passport.documentType,
    issuingCountry: passport.issuingCountry,
    expiresOn: passport.expiresOn,
  };
}

function parseUtc(value: string, label: string): number {
  if (typeof value !== 'string' || !UTC_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a UTC date or timestamp`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new TypeError(`${label} must be a UTC date or timestamp`);
  }
  return ms;
}

function checkActor(actorLabel: string): void {
  if (typeof actorLabel !== 'string' || !ACTOR_PATTERN.test(actorLabel)) {
    throw new TypeError('actorLabel must be a short machine label (letters, digits, _ . : -)');
  }
}
