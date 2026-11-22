import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import {
  verifyAccessToken,
  actorFromVerifiedClaims,
} from '../src/token.ts';
import type { PublicJwk, TokenConfig, VerifiedClaims } from '../src/token.ts';

const ISSUER = 'https://project.example.test/auth/v1';
const SECRET = 'test-only-hmac-secret-do-not-use-in-production';
const SUB = '3f6c2a1e-8b7d-4c9e-9a1f-2b3c4d5e6f70';
const NOW = '2026-11-19T12:00:00.000Z';
const NOW_SEC = Date.parse(NOW) / 1000;
const POLICY = { maxStaffSessionSeconds: 900 };

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

// Default claims for a well-formed access token. Overrides of undefined remove a claim.
function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: 'authenticated',
    role: 'authenticated',
    sub: SUB,
    iat: NOW_SEC - 10,
    exp: NOW_SEC + 3600,
    aal: 'aal1',
    email: 'customer@example.test',
    ...overrides,
  };
}

function hs256Token(payload: unknown, secret: string = SECRET, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }): string {
  const h = b64url(header);
  const p = b64url(payload);
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

function es256Token(payload: unknown, key: KeyObject, kid?: string): string {
  const header = { alg: 'ES256', typ: 'JWT', ...(kid !== undefined ? { kid } : {}) };
  const h = b64url(header);
  const p = b64url(payload);
  const sig = sign('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${h}.${p}.${sig}`;
}

function rs256Token(payload: unknown, key: KeyObject, kid?: string): string {
  const header = { alg: 'RS256', typ: 'JWT', ...(kid !== undefined ? { kid } : {}) };
  const h = b64url(header);
  const p = b64url(payload);
  const sig = sign('sha256', Buffer.from(`${h}.${p}`), key).toString('base64url');
  return `${h}.${p}.${sig}`;
}

function publicJwk(key: KeyObject, kid: string): PublicJwk {
  const jwk = key.export({ format: 'jwk' });
  return { kty: String(jwk.kty), crv: jwk.crv, x: jwk.x, y: jwk.y, n: jwk.n, e: jwk.e, kid };
}

const hmacConfig: TokenConfig = { hmacSecret: SECRET, issuer: ISSUER };

function expectOk(token: string, config: TokenConfig = hmacConfig): VerifiedClaims {
  const result = verifyAccessToken(token, config, NOW);
  assert.equal(result.ok, true, result.ok ? '' : `expected ok, got ${result.reason}`);
  if (!result.ok) throw new Error('unreachable');
  return result.claims;
}

function expectReason(token: string, reason: string, config: TokenConfig = hmacConfig): void {
  const result = verifyAccessToken(token, config, NOW);
  assert.deepEqual(result, { ok: false, reason });
}

describe('verifyAccessToken: HS256', () => {
  test('accepts a valid token and returns only the permitted claims', () => {
    const verified = expectOk(hs256Token(claims({ user_metadata: { role: 'admin' } })));
    assert.equal(verified.sub, SUB);
    assert.equal(verified.aal, 'aal1');
    assert.equal(verified.iat, NOW_SEC - 10);
    assert.equal(verified.exp, NOW_SEC + 3600);
    assert.equal(verified.email, 'customer@example.test');
    assert.equal('user_metadata' in verified, false);
    assert.equal('role' in verified, false);
  });

  test('rejects a bad signature (payload tampered after signing)', () => {
    const token = hs256Token(claims());
    const [h, , s] = token.split('.') as [string, string, string];
    const forged = b64url(claims({ sub: '00000000-0000-4000-8000-000000000001' }));
    expectReason(`${h}.${forged}.${s}`, 'bad signature');
  });

  test('rejects a token signed with a different secret', () => {
    expectReason(hs256Token(claims(), 'another-secret-entirely-different-value'), 'bad signature');
  });

  test('rejects alg none', () => {
    const h = b64url({ alg: 'none', typ: 'JWT' });
    const p = b64url(claims());
    const result = verifyAccessToken(`${h}.${p}.AAAA`, hmacConfig, NOW);
    assert.deepEqual(result, { ok: false, reason: 'algorithm not allowed' });
  });

  test('rejects an unsigned alg none token with an empty signature segment', () => {
    const h = b64url({ alg: 'none', typ: 'JWT' });
    const p = b64url(claims());
    assert.equal(verifyAccessToken(`${h}.${p}.`, hmacConfig, NOW).ok, false);
  });

  test('rejects an algorithm the service does not accept', () => {
    const h = b64url({ alg: 'HS512', typ: 'JWT' });
    const p = b64url(claims());
    const sig = createHmac('sha512', SECRET).update(`${h}.${p}`).digest('base64url');
    expectReason(`${h}.${p}.${sig}`, 'algorithm not allowed');
  });

  test('rejects an expired token', () => {
    expectReason(hs256Token(claims({ exp: NOW_SEC - 1 })), 'expired');
  });

  test('treats exp equal to now as expired', () => {
    expectReason(hs256Token(claims({ exp: NOW_SEC })), 'expired');
  });

  test('rejects a token whose nbf is in the future', () => {
    expectReason(hs256Token(claims({ nbf: NOW_SEC + 120 })), 'not yet valid');
  });

  test('accepts a token whose nbf has passed', () => {
    expectOk(hs256Token(claims({ nbf: NOW_SEC - 120 })));
  });

  test('rejects iat more than 60 seconds in the future', () => {
    expectReason(hs256Token(claims({ iat: NOW_SEC + 3600 })), 'issued in the future');
  });

  test('accepts iat up to 60 seconds in the future', () => {
    expectOk(hs256Token(claims({ iat: NOW_SEC + 60 })));
  });

  test('rejects a missing exp', () => {
    expectReason(hs256Token(claims({ exp: undefined })), 'missing exp');
  });

  test('rejects a missing iat', () => {
    expectReason(hs256Token(claims({ iat: undefined })), 'missing iat');
  });

  test('rejects a wrong issuer', () => {
    expectReason(hs256Token(claims({ iss: 'https://evil.example.test/auth/v1' })), 'wrong issuer');
  });

  test('rejects a wrong audience', () => {
    expectReason(hs256Token(claims({ aud: 'service_role' })), 'wrong audience');
  });

  test('rejects a role claim other than authenticated', () => {
    expectReason(hs256Token(claims({ role: 'service_role' })), 'wrong role');
    expectReason(hs256Token(claims({ role: 'anon' })), 'wrong role');
  });

  test('rejects a subject that is not a UUID', () => {
    expectReason(hs256Token(claims({ sub: 'not-a-uuid' })), 'malformed subject');
  });

  test('rejects structurally broken tokens without echoing them', () => {
    const malformed = [
      '',
      'a.b',
      'a.b.c.d',
      'not base64!.eyJ9.AAAA',
      `${b64url(['array'])}.${b64url(claims())}.AAAA`,
    ];
    for (const token of malformed) {
      const result = verifyAccessToken(token, hmacConfig, NOW);
      assert.equal(result.ok, false);
      if (!result.ok && token.length > 0) assert.equal(result.reason.includes(token), false);
    }
  });

  test('rejects an empty hmacSecret as a configuration error', () => {
    assert.throws(() => verifyAccessToken(hs256Token(claims()), { hmacSecret: '', issuer: ISSUER }, NOW), TypeError);
  });
});

describe('verifyAccessToken: ES256 and RS256', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const otherEc = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ecConfig: TokenConfig = { publicKeys: [publicJwk(ec.publicKey, 'ec-1')], issuer: ISSUER };

  test('accepts a valid ES256 token whose kid matches the configured key', () => {
    const verified = expectOk(es256Token(claims(), ec.privateKey, 'ec-1'), ecConfig);
    assert.equal(verified.sub, SUB);
  });

  test('accepts an ES256 token with no kid when a key of the right type is configured', () => {
    expectOk(es256Token(claims(), ec.privateKey), ecConfig);
  });

  test('rejects an ES256 token signed by a key that is not configured', () => {
    expectReason(es256Token(claims(), otherEc.privateKey, 'ec-1'), 'bad signature', ecConfig);
  });

  test('rejects an ES256 token whose kid is unknown', () => {
    expectReason(es256Token(claims(), ec.privateKey, 'ec-unknown'), 'bad signature', ecConfig);
  });

  test('rejects an ES256 token that has been tampered with', () => {
    const token = es256Token(claims(), ec.privateKey, 'ec-1');
    const [h, , s] = token.split('.') as [string, string, string];
    const forged = b64url(claims({ role: 'admin' }));
    expectReason(`${h}.${forged}.${s}`, 'bad signature', ecConfig);
  });

  test('alg confusion: an HS256 token is rejected by an EC-only configuration', () => {
    const publicPem = ec.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    // The classic attack: sign HS256 using the public key text as the HMAC secret.
    const forged = hs256Token(claims(), publicPem);
    expectReason(forged, 'algorithm not enabled', ecConfig);
  });

  test('alg confusion: an ES256 header is rejected when only an RSA key is configured', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaOnly: TokenConfig = { publicKeys: [publicJwk(rsa.publicKey, 'rsa-1')], issuer: ISSUER };
    expectReason(es256Token(claims(), ec.privateKey), 'bad signature', rsaOnly);
  });

  test('accepts a valid RS256 token from a matching RSA key', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaConfig: TokenConfig = { publicKeys: [publicJwk(rsa.publicKey, 'rsa-1')], issuer: ISSUER };
    expectOk(rs256Token(claims(), rsa.privateKey, 'rsa-1'), rsaConfig);
    expectReason(rs256Token(claims(), rsa.privateKey, 'rsa-2'), 'bad signature', rsaConfig);
  });

  test('a configuration with both secret and key still rejects alg none', () => {
    const both: TokenConfig = { hmacSecret: SECRET, publicKeys: [publicJwk(ec.publicKey, 'ec-1')], issuer: ISSUER };
    const h = b64url({ alg: 'none' });
    assert.equal(verifyAccessToken(`${h}.${b64url(claims())}.AAAA`, both, NOW).ok, false);
  });
});

describe('actorFromVerifiedClaims', () => {
  const verified = (overrides: Record<string, unknown> = {}): VerifiedClaims => {
    const result = verifyAccessToken(hs256Token(claims(overrides)), hmacConfig, NOW);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    return result.claims;
  };

  test('takes the role from the database, ignoring user_metadata in the token', () => {
    const claimsWithMetadata = verified({ user_metadata: { role: 'admin' }, aal: 'aal2' });
    const actor = actorFromVerifiedClaims(claimsWithMetadata, 'customer', NOW, POLICY);
    assert.deepEqual(actor, { kind: 'user', userId: SUB, role: 'customer', mfa: true });
  });

  test('a customer gets mfa only from aal2', () => {
    assert.deepEqual(actorFromVerifiedClaims(verified({ aal: 'aal1' }), 'customer', NOW, POLICY), {
      kind: 'user',
      userId: SUB,
      role: 'customer',
      mfa: false,
    });
  });

  test('staff without aal2 get mfa false but an actor is still returned', () => {
    const actor = actorFromVerifiedClaims(verified({ aal: 'aal1' }), 'admin', NOW, POLICY);
    assert.deepEqual(actor, { kind: 'user', userId: SUB, role: 'admin', mfa: false });
  });

  test('staff with aal2 and a fresh session get mfa true', () => {
    const actor = actorFromVerifiedClaims(verified({ aal: 'aal2', iat: NOW_SEC - 300 }), 'support', NOW, POLICY);
    assert.deepEqual(actor, { kind: 'user', userId: SUB, role: 'support', mfa: true });
  });

  test('staff with aal2 but a stale session get mfa false', () => {
    const actor = actorFromVerifiedClaims(verified({ aal: 'aal2', iat: NOW_SEC - 901 }), 'admin', NOW, POLICY);
    assert.deepEqual(actor, { kind: 'user', userId: SUB, role: 'admin', mfa: false });
  });

  test('a session exactly at the freshness limit is still fresh', () => {
    const actor = actorFromVerifiedClaims(verified({ aal: 'aal2', iat: NOW_SEC - 900 }), 'admin', NOW, POLICY);
    assert.equal(actor?.kind === 'user' && actor.mfa, true);
  });

  test('a null database role denies the request', () => {
    assert.equal(actorFromVerifiedClaims(verified({ aal: 'aal2' }), null, NOW, POLICY), null);
  });

  test('an unknown database role denies the request', () => {
    assert.equal(actorFromVerifiedClaims(verified(), 'superuser' as never, NOW, POLICY), null);
  });

  test('a missing or non-positive maxStaffSessionSeconds throws a TypeError', () => {
    const v = verified();
    assert.throws(() => actorFromVerifiedClaims(v, 'customer', NOW, {} as never), TypeError);
    assert.throws(() => actorFromVerifiedClaims(v, 'customer', NOW, { maxStaffSessionSeconds: 0 }), TypeError);
    assert.throws(() => actorFromVerifiedClaims(v, 'customer', NOW, { maxStaffSessionSeconds: -5 }), TypeError);
    assert.throws(() => actorFromVerifiedClaims(v, 'customer', NOW, { maxStaffSessionSeconds: 1.5 }), TypeError);
    assert.throws(() => actorFromVerifiedClaims(v, 'customer', NOW, { maxStaffSessionSeconds: NaN }), TypeError);
    assert.throws(() => actorFromVerifiedClaims(v, 'customer', NOW, undefined as never), TypeError);
  });
});
