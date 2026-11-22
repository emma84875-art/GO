// Field-level encryption for personal data (AES-256-GCM).
//
// Keys are injected by the caller. This module never reads the environment. Each
// ciphertext is bound to its row through the additional authenticated data (aad),
// so a token copied to another row fails to decrypt. Errors are generic: they never
// include the plaintext, the ciphertext, the token or any key material.
//
// Token format: v1.<keyId>.<base64url iv>.<base64url tag>.<base64url ciphertext>

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 4096;
const KEY_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export class FieldCrypto {
  readonly #keys: Map<string, Buffer>;
  readonly #activeKeyId: string;

  constructor(keyring: Readonly<Record<string, Uint8Array>>, activeKeyId: string) {
    if (typeof keyring !== 'object' || keyring === null) {
      throw new TypeError('keyring must be an object');
    }
    const entries = Object.entries(keyring);
    if (entries.length === 0) {
      throw new TypeError('keyring must contain at least one key');
    }
    const keys = new Map<string, Buffer>();
    for (const [keyId, key] of entries) {
      if (!KEY_ID_PATTERN.test(keyId)) {
        throw new TypeError('key ids must match /^[a-z0-9_-]{1,32}$/');
      }
      if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
        throw new TypeError('each key must be exactly 32 bytes');
      }
      // Copy so that later changes to the caller's buffer cannot alter the keyring.
      keys.set(keyId, Buffer.from(key));
    }
    if (typeof activeKeyId !== 'string' || !keys.has(activeKeyId)) {
      throw new TypeError('the active key id must exist in the keyring');
    }
    this.#keys = keys;
    this.#activeKeyId = activeKeyId;
  }

  encrypt(plaintext: string, aad: string): string {
    if (typeof plaintext !== 'string' || typeof aad !== 'string') {
      throw new TypeError('plaintext and aad must be strings');
    }
    const data = Buffer.from(plaintext, 'utf8');
    if (data.byteLength === 0) {
      throw new RangeError('plaintext must not be empty');
    }
    if (data.byteLength > MAX_PLAINTEXT_BYTES) {
      throw new RangeError(`plaintext exceeds the ${MAX_PLAINTEXT_BYTES} byte limit`);
    }
    const key = this.#keys.get(this.#activeKeyId);
    if (key === undefined) {
      throw new Error('unknown_key');
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      this.#activeKeyId,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(token: string, aad: string): string {
    if (typeof token !== 'string' || typeof aad !== 'string') {
      throw new Error('decryption_failed');
    }
    const parts = token.split('.');
    if (parts.length !== 5) {
      throw new Error('decryption_failed');
    }
    const [version, keyId, ivPart, tagPart, ctPart] = parts as [string, string, string, string, string];
    if (version !== VERSION || !KEY_ID_PATTERN.test(keyId)) {
      throw new Error('decryption_failed');
    }
    const iv = decodeStrict(ivPart);
    const tag = decodeStrict(tagPart);
    const ciphertext = decodeStrict(ctPart);
    if (iv === null || tag === null || ciphertext === null) {
      throw new Error('decryption_failed');
    }
    if (iv.byteLength !== IV_BYTES || tag.byteLength !== TAG_BYTES) {
      throw new Error('decryption_failed');
    }
    if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_PLAINTEXT_BYTES) {
      throw new Error('decryption_failed');
    }
    const key = this.#keys.get(keyId);
    if (key === undefined) {
      throw new Error('unknown_key');
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plain.toString('utf8');
    } catch {
      // The Node error is dropped on purpose: its text can echo crypto internals.
      throw new Error('decryption_failed');
    }
  }
}

// Accepts only canonical base64url, so a token has exactly one textual form.
function decodeStrict(part: string): Buffer | null {
  if (!BASE64URL_PATTERN.test(part)) return null;
  const bytes = Buffer.from(part, 'base64url');
  return bytes.toString('base64url') === part ? bytes : null;
}
