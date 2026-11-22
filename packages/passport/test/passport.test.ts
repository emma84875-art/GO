import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validatePassport, type PassportInput } from '../src/fields.ts';
import { collectionDecision } from '../src/policy.ts';
import { PassportVault, passportLogFields } from '../src/vault.ts';
import { FieldCrypto } from '../../security/src/field-crypto.ts';

const TODAY = '2026-11-19';
const TRAVEL = '2027-03-01';
const NUMBER = 'P1234567X';
const PASSPORT: PassportInput = {
  documentType: 'passport',
  number: NUMBER,
  issuingCountry: 'GB',
  expiresOn: '2031-06-30',
};

describe('validatePassport', () => {
  test('accepts a valid passport and returns normalised fields', () => {
    const result = validatePassport({ ...PASSPORT, number: ' p1234567x ' }, TRAVEL, TODAY);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, {});
    assert.deepEqual(result.normalised, PASSPORT);
  });

  test('refuses a document type other than passport', () => {
    for (const documentType of ['national_id', 'Passport', 'visa', '']) {
      const result = validatePassport({ ...PASSPORT, documentType }, TRAVEL, TODAY);
      assert.equal(result.valid, false, documentType);
      assert.ok(result.errors.documentType !== undefined);
      assert.equal(result.normalised, null);
    }
  });

  test('refuses an expiry before the travel date', () => {
    const result = validatePassport({ ...PASSPORT, expiresOn: '2027-02-28' }, TRAVEL, TODAY);
    assert.equal(result.valid, false);
    assert.ok(result.errors.expiresOn !== undefined);
  });

  test('refuses an expiry on the travel date itself', () => {
    const result = validatePassport({ ...PASSPORT, expiresOn: TRAVEL }, TRAVEL, TODAY);
    assert.equal(result.valid, false);
    assert.ok(result.errors.expiresOn !== undefined);
  });

  test('refuses an expiry in the past', () => {
    const result = validatePassport({ ...PASSPORT, expiresOn: '2026-01-01' }, TRAVEL, TODAY);
    assert.equal(result.valid, false);
    assert.equal(result.errors.expiresOn, 'This document has expired.');
  });

  test('refuses an unknown issuing country and an invalid expiry date', () => {
    const country = validatePassport({ ...PASSPORT, issuingCountry: 'ZZ' }, TRAVEL, TODAY);
    assert.ok(country.errors.issuingCountry !== undefined);
    const date = validatePassport({ ...PASSPORT, expiresOn: '2031-02-30' }, TRAVEL, TODAY);
    assert.ok(date.errors.expiresOn !== undefined);
  });

  test('error text never contains the number', () => {
    const badNumber = 'SECRET-99!!';
    const cases = [
      validatePassport({ ...PASSPORT, number: badNumber }, TRAVEL, TODAY),
      validatePassport({ ...PASSPORT, number: NUMBER, expiresOn: '2026-01-01' }, TRAVEL, TODAY),
      validatePassport({ ...PASSPORT, number: NUMBER, documentType: 'visa' }, TRAVEL, TODAY),
      validatePassport({ ...PASSPORT, number: NUMBER, expiresOn: '2027-01-01' }, TRAVEL, TODAY),
    ];
    for (const result of cases) {
      const text = JSON.stringify(result.errors);
      assert.equal(text.includes(badNumber), false);
      assert.equal(text.includes(NUMBER), false);
    }
  });

  test('throws a TypeError for a non-date travel date', () => {
    assert.throws(() => validatePassport(PASSPORT, '2027-13-01', TODAY), TypeError);
  });
});

describe('collectionDecision', () => {
  test('unknown never collects, even with consent', () => {
    assert.deepEqual(collectionDecision('unknown', false), { collect: false, reason: 'requirement_unknown' });
    assert.equal(collectionDecision('unknown', true).collect, false);
  });

  test('not_required never collects, even with consent', () => {
    assert.equal(collectionDecision('not_required', false).collect, false);
    assert.equal(collectionDecision('not_required', true).collect, false);
  });

  test('optional collects only with consent', () => {
    assert.equal(collectionDecision('optional', false).collect, false);
    assert.equal(collectionDecision('optional', true).collect, true);
  });

  test('required collects', () => {
    assert.equal(collectionDecision('required', false).collect, true);
    assert.equal(collectionDecision('required', true).collect, true);
  });

  test('an unexpected requirement value does not collect', () => {
    assert.equal(collectionDecision('maybe' as never, true).collect, false);
  });
});

function makeVault(retentionDays = 30): PassportVault {
  const cipher = new FieldCrypto({ k1: new Uint8Array(32).fill(5) }, 'k1');
  return new PassportVault(cipher, retentionDays);
}

describe('PassportVault construction', () => {
  test('refuses retentionDays of 0, undefined, negatives and fractions', () => {
    const cipher = new FieldCrypto({ k1: new Uint8Array(32).fill(5) }, 'k1');
    assert.throws(() => new PassportVault(cipher, 0), TypeError);
    assert.throws(() => new PassportVault(cipher, undefined as never), TypeError);
    assert.throws(() => new PassportVault(cipher, -1), TypeError);
    assert.throws(() => new PassportVault(cipher, 1.5), TypeError);
  });
});

describe('PassportVault store and read', () => {
  test('round trip returns the same fields', () => {
    const vault = makeVault();
    const { ref } = vault.store({ bookingId: 'BK1', passengerIndex: 0, passport: PASSPORT }, '2026-11-19');
    assert.deepEqual(vault.read(ref, 'supplier_order', 'fulfilment_worker', '2026-11-19'), PASSPORT);
  });

  test('the ref is an opaque random id and differs per store', () => {
    const vault = makeVault();
    const a = vault.store({ bookingId: 'BK1', passengerIndex: 0, passport: PASSPORT }, '2026-11-19').ref;
    const b = vault.store({ bookingId: 'BK1', passengerIndex: 0, passport: PASSPORT }, '2026-11-19').ref;
    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f-]{36}$/);
  });

  test('stored internals contain no plaintext number or expiry', () => {
    const vault = makeVault();
    vault.store({ bookingId: 'BK1', passengerIndex: 0, passport: PASSPORT }, '2026-11-19');
    const dump = JSON.stringify(vault.dumpForAudit());
    assert.equal(dump.includes(NUMBER), false);
    assert.equal(dump.includes('2031-06-30'), false);
    assert.equal(JSON.stringify(vault).includes(NUMBER), false);
    for (const item of vault.dumpForAudit()) {
      assert.match(item, /^v1\./);
    }
  });

  test('refuses to store a non-passport document', () => {
    const vault = makeVault();
    assert.throws(
      () => vault.store({ bookingId: 'BK1', passengerIndex: 0, passport: { ...PASSPORT, documentType: 'visa' } }, '2026-11-19'),
      TypeError,
    );
  });

  test('read refuses any purpose other than supplier_order', () => {
    const vault = makeVault();
    const { ref } = vault.store({ bookingId: 'BK1', passengerIndex: 0, passport: PASSPORT }, '2026-11-19');
    assert.throws(() => vault.read(ref, 'marketing' as never, 'worker', '2026-11-19'), /purpose_not_allowed/);
    assert.equal(vault.accessLog().length, 0);
  });

  test('read refuses a malformed actor label without echoing it', () => {
    const vault = makeVault();
    const { ref } = vault.store({ bookingId: 'BK1', passengerIndex: 0, passport: PASSPORT }, '2026-11-19');
    assert.throws(() => vault.read(ref, 'supplier_order', 'Ada Lovelace', '2026-11-19'), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(String(error).includes('Ada'), false);
      return true;
    });
  });

  test('every read appends an access-log entry without personal data', () => {
    const vault = makeVault();
    const { ref } = vault.store({ bookingId: 'BK1', passengerIndex: 0, passport: PASSPORT }, '2026-11-19');
    vault.read(ref, 'supplier_order', 'fulfilment_worker', '2026-11-20');
    vault.read(ref, 'supplier_order', 'fulfilment_worker', '2026-11-21');
    const log = vault.accessLog();
    assert.equal(log.length, 2);
    assert.deepEqual(log[0], { at: '2026-11-20', ref, purpose: 'supplier_order', actorLabel: 'fulfilment_worker' });
    assert.deepEqual(Object.keys(log[1] as object).sort(), ['actorLabel', 'at', 'purpose', 'ref']);
  });

  test('accessLog returns a copy that cannot change the vault', () => {
    const vault = makeVault();
    const { ref } = vault.store({ bookingId: 'BK1', passengerIndex: 0, passport: PASSPORT }, '2026-11-19');
    vault.read(ref, 'supplier_order', 'worker', '2026-11-19');
    (vault.accessLog() as unknown as Array<{ ref: string }>)[0]!.ref = 'tampered';
    assert.equal(vault.accessLog()[0]!.ref, ref);
  });

  test('a read of an unknown ref throws not_found and is not logged', () => {
    const vault = makeVault();
    assert.throws(() => vault.read('00000000-0000-4000-8000-000000000000', 'supplier_order', 'worker', '2026-11-19'), /^Error: not_found$/);
    assert.equal(vault.accessLog().length, 0);
  });
});

describe('PassportVault purge', () => {
  test('purgeDue removes records past retention and keeps the others', () => {
    const vault = makeVault(30);
    const early = vault.store({ bookingId: 'BK1', passengerIndex: 0, passport: PASSPORT }, '2026-11-19').ref;
    const late = vault.store({ bookingId: 'BK2', passengerIndex: 0, passport: PASSPORT }, '2026-12-10').ref;

    assert.equal(vault.purgeDue('2026-12-18'), 0);
    assert.equal(vault.purgeDue('2026-12-19'), 1);

    assert.throws(() => vault.read(early, 'supplier_order', 'worker', '2026-12-19'), /not_found/);
    assert.deepEqual(vault.read(late, 'supplier_order', 'worker', '2026-12-19'), PASSPORT);
    assert.equal(vault.dumpForAudit().length, 2);
  });

  test('a record past retention is refused even before purgeDue runs', () => {
    const vault = makeVault(30);
    const { ref } = vault.store({ bookingId: 'BK1', passengerIndex: 0, passport: PASSPORT }, '2026-11-19');
    assert.throws(() => vault.read(ref, 'supplier_order', 'worker', '2026-12-25'), /not_found/);
  });

  test('purge log records ref and time only, and purgeDue is idempotent', () => {
    const vault = makeVault(1);
    const { ref } = vault.store({ bookingId: 'BK1', passengerIndex: 0, passport: PASSPORT }, '2026-11-19');
    assert.equal(vault.purgeDue('2026-11-21'), 1);
    assert.equal(vault.purgeDue('2026-11-21'), 0);
    assert.deepEqual(vault.purgeLog(), [{ at: '2026-11-21', ref }]);
  });
});

describe('PassportVault logs carry no personal data', () => {
  test('access and purge logs contain no number or expiry date', () => {
    const vault = makeVault(1);
    const { ref } = vault.store({ bookingId: 'BK1', passengerIndex: 0, passport: PASSPORT }, '2026-11-19');
    vault.read(ref, 'supplier_order', 'fulfilment_worker', '2026-11-19');
    vault.purgeDue('2026-12-31');
    const text = JSON.stringify(vault.accessLog()) + JSON.stringify(vault.purgeLog());
    assert.equal(text.includes(NUMBER), false);
    assert.equal(text.includes('2031-06-30'), false);
    assert.equal(text.includes('GB'), false);
  });
});

describe('passportLogFields', () => {
  test('omits the number', () => {
    const fields = passportLogFields(PASSPORT);
    assert.deepEqual(fields, { documentType: 'passport', issuingCountry: 'GB', expiresOn: '2031-06-30' });
    assert.equal(JSON.stringify(fields).includes(NUMBER), false);
    assert.equal('number' in fields, false);
  });
});
