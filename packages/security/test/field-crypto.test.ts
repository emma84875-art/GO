import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FieldCrypto } from '../src/field-crypto.ts';

const KEY_A = new Uint8Array(32).fill(7);
const KEY_B = new Uint8Array(32).fill(9);
const PLAIN = 'PASSPORT-AB123456 Ada Lovelace 1990-12-10';
const AAD = 'passenger_documents:number:row-1';

function flipByte(token: string, partIndex: number, byteIndex: number): string {
  const parts = token.split('.');
  const bytes = Buffer.from(parts[partIndex] as string, 'base64url');
  bytes[byteIndex] ^= 0x01;
  parts[partIndex] = bytes.toString('base64url');
  return parts.join('.');
}

function errorText(error: unknown): string {
  return `${String(error)} ${error instanceof Error ? error.message : ''}`;
}

describe('FieldCrypto construction', () => {
  test('refuses an empty keyring', () => {
    assert.throws(() => new FieldCrypto({}, 'k1'), TypeError);
  });

  test('refuses a key that is not exactly 32 bytes', () => {
    assert.throws(() => new FieldCrypto({ k1: new Uint8Array(31) }, 'k1'), TypeError);
    assert.throws(() => new FieldCrypto({ k1: new Uint8Array(33) }, 'k1'), TypeError);
  });

  test('refuses a key id outside the allowed pattern', () => {
    assert.throws(() => new FieldCrypto({ 'K1': KEY_A }, 'K1'), TypeError);
    assert.throws(() => new FieldCrypto({ 'a.b': KEY_A }, 'a.b'), TypeError);
    assert.throws(() => new FieldCrypto({ ['x'.repeat(33)]: KEY_A }, 'x'.repeat(33)), TypeError);
  });

  test('refuses an active key id that is not in the keyring', () => {
    assert.throws(() => new FieldCrypto({ k1: KEY_A }, 'k2'), TypeError);
  });
});

describe('FieldCrypto encrypt and decrypt', () => {
  test('round trip returns the original plaintext', () => {
    const crypto = new FieldCrypto({ k1: KEY_A }, 'k1');
    const token = crypto.encrypt(PLAIN, AAD);
    assert.equal(crypto.decrypt(token, AAD), PLAIN);
  });

  test('round trip works for multi-byte text', () => {
    const crypto = new FieldCrypto({ k1: KEY_A }, 'k1');
    const text = 'Ọlá Adébáyọ̀ 名前';
    assert.equal(crypto.decrypt(crypto.encrypt(text, AAD), AAD), text);
  });

  test('output has the documented format and does not contain the plaintext', () => {
    const crypto = new FieldCrypto({ k1: KEY_A }, 'k1');
    const token = crypto.encrypt(PLAIN, AAD);
    const parts = token.split('.');
    assert.equal(parts.length, 5);
    assert.equal(parts[0], 'v1');
    assert.equal(parts[1], 'k1');
    assert.equal(Buffer.from(parts[2] as string, 'base64url').byteLength, 12);
    assert.equal(Buffer.from(parts[3] as string, 'base64url').byteLength, 16);
    assert.equal(token.includes('PASSPORT'), false);
    assert.equal(token.includes('Ada'), false);
    assert.equal(token.includes(PLAIN), false);
  });

  test('two encryptions of the same plaintext differ (random IV)', () => {
    const crypto = new FieldCrypto({ k1: KEY_A }, 'k1');
    assert.notEqual(crypto.encrypt(PLAIN, AAD), crypto.encrypt(PLAIN, AAD));
  });

  test('rejects an empty plaintext with a RangeError that does not echo input', () => {
    const crypto = new FieldCrypto({ k1: KEY_A }, 'k1');
    assert.throws(() => crypto.encrypt('', AAD), (error: unknown) => {
      assert.ok(error instanceof RangeError);
      return true;
    });
  });

  test('rejects a plaintext over 4096 bytes without echoing it', () => {
    const crypto = new FieldCrypto({ k1: KEY_A }, 'k1');
    const secret = 'S3CRET' + 'x'.repeat(4096);
    assert.throws(() => crypto.encrypt(secret, AAD), (error: unknown) => {
      assert.ok(error instanceof RangeError);
      assert.equal(errorText(error).includes('S3CRET'), false);
      return true;
    });
  });

  test('accepts exactly 4096 bytes', () => {
    const crypto = new FieldCrypto({ k1: KEY_A }, 'k1');
    const text = 'a'.repeat(4096);
    assert.equal(crypto.decrypt(crypto.encrypt(text, AAD), AAD), text);
  });
});

describe('FieldCrypto tamper and binding checks', () => {
  test('wrong aad fails with decryption_failed', () => {
    const crypto = new FieldCrypto({ k1: KEY_A }, 'k1');
    const token = crypto.encrypt(PLAIN, AAD);
    assert.throws(() => crypto.decrypt(token, 'passenger_documents:number:row-2'), /^Error: decryption_failed$/);
  });

  test('a flipped byte in the ciphertext fails', () => {
    const crypto = new FieldCrypto({ k1: KEY_A }, 'k1');
    const token = crypto.encrypt(PLAIN, AAD);
    assert.throws(() => crypto.decrypt(flipByte(token, 4, 0), AAD), (error: unknown) => {
      assert.equal(errorText(error).includes('decryption_failed'), true);
      return true;
    });
  });

  test('a flipped byte in the tag fails', () => {
    const crypto = new FieldCrypto({ k1: KEY_A }, 'k1');
    const token = crypto.encrypt(PLAIN, AAD);
    assert.throws(() => crypto.decrypt(flipByte(token, 3, 5), AAD), (error: unknown) => {
      assert.equal(errorText(error).includes('decryption_failed'), true);
      return true;
    });
  });

  test('a flipped byte in the IV fails', () => {
    const crypto = new FieldCrypto({ k1: KEY_A }, 'k1');
    const token = crypto.encrypt(PLAIN, AAD);
    assert.throws(() => crypto.decrypt(flipByte(token, 2, 3), AAD), /decryption_failed/);
  });

  test('the wrong key fails with decryption_failed', () => {
    const writer = new FieldCrypto({ k1: KEY_A }, 'k1');
    const reader = new FieldCrypto({ k1: KEY_B }, 'k1');
    assert.throws(() => reader.decrypt(writer.encrypt(PLAIN, AAD), AAD), /decryption_failed/);
  });

  test('an unknown key id fails with unknown_key', () => {
    const writer = new FieldCrypto({ k1: KEY_A, k2: KEY_B }, 'k2');
    const reader = new FieldCrypto({ k1: KEY_A }, 'k1');
    assert.throws(() => reader.decrypt(writer.encrypt(PLAIN, AAD), AAD), /unknown_key/);
  });

  test('an unknown version fails with decryption_failed', () => {
    const crypto = new FieldCrypto({ k1: KEY_A }, 'k1');
    const token = crypto.encrypt(PLAIN, AAD).replace(/^v1\./, 'v2.');
    assert.throws(() => crypto.decrypt(token, AAD), /decryption_failed/);
  });
});

describe('FieldCrypto key rotation', () => {
  test('a token written under the old key still decrypts after rotation', () => {
    const before = new FieldCrypto({ k1: KEY_A }, 'k1');
    const oldToken = before.encrypt(PLAIN, AAD);

    const after = new FieldCrypto({ k1: KEY_A, k2: KEY_B }, 'k2');
    assert.equal(after.decrypt(oldToken, AAD), PLAIN);

    const newToken = after.encrypt(PLAIN, AAD);
    assert.equal(newToken.split('.')[1], 'k2');
    assert.equal(after.decrypt(newToken, AAD), PLAIN);
  });

  test('new tokens use the active key even when an older key is in the ring', () => {
    const crypto = new FieldCrypto({ k1: KEY_A, k2: KEY_B }, 'k2');
    assert.equal(crypto.encrypt(PLAIN, AAD).split('.')[1], 'k2');
  });
});

describe('FieldCrypto malformed tokens', () => {
  const crypto = new FieldCrypto({ k1: KEY_A }, 'k1');
  const good = crypto.encrypt(PLAIN, AAD);
  const cases: Record<string, string> = {
    empty: '',
    'too few parts': 'v1.k1.abc',
    'too many parts': `${good}.extra`,
    'bad key id': good.replace('.k1.', '.K1!.'),
    'non-canonical base64url': good.replace(/\.([A-Za-z0-9_-]{16})\./, '.$1=.'),
    'short iv': good.split('.').map((p, i) => (i === 2 ? 'AAAA' : p)).join('.'),
    'empty ciphertext': good.split('.').slice(0, 4).concat('').join('.'),
    'garbage': 'not a token at all',
  };
  for (const [label, token] of Object.entries(cases)) {
    test(`rejects ${label}`, () => {
      assert.throws(() => crypto.decrypt(token, AAD), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(errorText(error).includes(PLAIN), false);
        return true;
      });
    });
  }
});

describe('FieldCrypto error hygiene', () => {
  test('error text contains neither the plaintext nor the key bytes', () => {
    const crypto = new FieldCrypto({ k1: KEY_A }, 'k1');
    const token = crypto.encrypt(PLAIN, AAD);
    const keyHex = Buffer.from(KEY_A).toString('hex');
    const keyB64 = Buffer.from(KEY_A).toString('base64');
    const keyB64u = Buffer.from(KEY_A).toString('base64url');
    const failures: unknown[] = [];
    const attempts: Array<() => unknown> = [
      () => crypto.decrypt(flipByte(token, 4, 1), AAD),
      () => crypto.decrypt(token, 'other'),
      () => new FieldCrypto({ k1: KEY_B }, 'k1').decrypt(token, AAD),
      () => crypto.decrypt('garbage', AAD),
      () => crypto.encrypt('', AAD),
      () => crypto.encrypt('x'.repeat(5000), AAD),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (error) {
        failures.push(error);
      }
    }
    assert.equal(failures.length, attempts.length);
    for (const error of failures) {
      const text = errorText(error);
      assert.equal(text.includes(PLAIN), false);
      assert.equal(text.includes('Ada'), false);
      assert.equal(text.includes(keyHex), false);
      assert.equal(text.includes(keyB64), false);
      assert.equal(text.includes(keyB64u), false);
      assert.equal(text.includes(token), false);
    }
  });
});
