// Unit checks for passenger personal data encryption (Phase 19.2, docs/26, section 6). The key is a test key; no key
// material is stored or logged by these tests.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { FieldCrypto } from '../../security/src/field-crypto.ts';
import { PassengerVault } from '../src/passenger-vault.ts';

const BOOKING = '00000000-0000-0000-0000-0000000000e1';
const OTHER_BOOKING = '00000000-0000-0000-0000-0000000000e2';
const DETAILS = { firstName: 'Ada', lastName: 'Okafor', dateOfBirth: '1990-05-14' };

function vault(keyId = 'k1', key = randomBytes(32)) {
  return new PassengerVault(new FieldCrypto({ [keyId]: key }, keyId));
}

describe('passenger personal data', () => {
  test('a sealed passenger opens to the same details', () => {
    const v = vault();
    const sealed = v.seal(BOOKING, 0, DETAILS);
    assert.deepEqual(v.open(BOOKING, 0, sealed), DETAILS);
  });

  test('no sealed value contains the plaintext name or date of birth', () => {
    const sealed = vault().seal(BOOKING, 0, DETAILS);
    for (const token of Object.values(sealed)) {
      assert.doesNotMatch(token, /Ada|Okafor|1990/);
    }
  });

  test('a value cannot be opened for another booking, passenger position, or field', () => {
    const v = vault();
    const sealed = v.seal(BOOKING, 0, DETAILS);
    assert.throws(() => v.open(OTHER_BOOKING, 0, sealed));
    assert.throws(() => v.open(BOOKING, 1, sealed));
    assert.throws(() => v.open(BOOKING, 0, { ...sealed, firstNameSealed: sealed.lastNameSealed }));
  });

  test('a value cannot be opened with another key', () => {
    const sealed = vault('k1', randomBytes(32)).seal(BOOKING, 0, DETAILS);
    assert.throws(() => vault('k1', randomBytes(32)).open(BOOKING, 0, sealed));
  });

  test('a name with digits or markup is refused', () => {
    const v = vault();
    assert.throws(() => v.seal(BOOKING, 0, { ...DETAILS, firstName: 'Ada<script>' }), RangeError);
    assert.throws(() => v.seal(BOOKING, 0, { ...DETAILS, lastName: '' }), RangeError);
  });

  test('a date of birth must be a real date', () => {
    const v = vault();
    assert.throws(() => v.seal(BOOKING, 0, { ...DETAILS, dateOfBirth: '1990-02-31' }), RangeError);
    assert.throws(() => v.seal(BOOKING, 0, { ...DETAILS, dateOfBirth: '14/05/1990' }), RangeError);
  });
});
