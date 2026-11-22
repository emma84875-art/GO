// Access-token verification for GO.
//
// Rules:
//   - Only HS256 (when a shared secret is configured), ES256 and RS256 (when a matching public key is
//     configured) are accepted. "none" and every other algorithm are rejected.
//   - The header algorithm must match the kind of key that checks it. An HS256 token presented to an
//     asymmetric-only configuration has no secret to check against and is rejected.
//   - The token's user_metadata is never read. Roles come from the database (see actorFromVerifiedClaims).
//   - Failure reasons are short fixed strings. They never echo token contents.
//
// Signature note: HMAC signatures are compared with timingSafeEqual. Asymmetric signatures are checked
// with node:crypto verify(), which is the correct primitive for them (there is no secret to compare).

import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import type { Actor, Role } from './actor.ts';

// The subset of a JSON Web Key this module reads. Private members (d, p, q, ...) are never copied
// into a key object, so passing a private JWK by mistake cannot leak into verification.
export type PublicJwk = {
  readonly kty: string;
  readonly crv?: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
  readonly x?: string;
  readonly y?: string;
  readonly n?: string;
  readonly e?: string;
};

export type TokenConfig = {
  readonly hmacSecret?: string;
  readonly publicKeys?: readonly PublicJwk[];
  readonly issuer: string;
};

// The only claims the rest of GO may see. user_metadata is deliberately absent.
export type VerifiedClaims = {
  readonly sub: string;
  readonly aal: string | undefined;
  readonly iat: number;
  readonly exp: number;
  readonly email?: string;
};

export type TokenResult = { ok: true; claims: VerifiedClaims } | { ok: false; reason: string };

export type ActorPolicy = { readonly maxStaffSessionSeconds: number };

const MAX_TOKEN_LENGTH = 8192;
const MAX_FUTURE_IAT_SECONDS = 60;
const AUDIENCE = 'authenticated';
const SUBJECT_ROLE = 'authenticated';
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ROLES: readonly Role[] = ['customer', 'support', 'operations', 'admin'];

// Converts an ISO 8601 UTC instant (must end in Z) to whole epoch seconds.
function epochSeconds(nowUtc: string): number {
  if (typeof nowUtc !== 'string' || !UTC_INSTANT.test(nowUtc)) {
    throw new TypeError('nowUtc must be an ISO 8601 UTC timestamp ending in Z');
  }
  const ms = Date.parse(nowUtc);
  if (!Number.isFinite(ms)) throw new TypeError('nowUtc is not a valid timestamp');
  return Math.floor(ms / 1000);
}

function decodeSegment(segment: string): Buffer | null {
  if (!BASE64URL.test(segment)) return null;
  return Buffer.from(segment, 'base64url');
}

function parseJsonObject(bytes: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function verifyHmac(secret: string, signingInput: string, signature: Buffer): boolean {
  const expected = createHmac('sha256', secret).update(signingInput).digest();
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(expected, signature);
}

// Builds a key object from only the public members of a JWK. Returns null if the JWK is unusable.
function publicKeyFrom(jwk: PublicJwk): KeyObject | null {
  try {
    if (jwk.kty === 'EC') {
      return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
    }
    if (jwk.kty === 'RSA') {
      return createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    }
    return null;
  } catch {
    return null;
  }
}

// Tries each configured key of the type the algorithm needs. A key is a candidate only if its kid
// matches the token's kid (when the token names one). Returns true if any candidate verifies.
function verifyWithPublicKeys(
  alg: 'ES256' | 'RS256',
  kid: string | undefined,
  signingInput: string,
  signature: Buffer,
  keys: readonly PublicJwk[],
): boolean {
  const wantedKty = alg === 'ES256' ? 'EC' : 'RSA';
  const data = Buffer.from(signingInput, 'utf8');
  for (const jwk of keys) {
    if (jwk.kty !== wantedKty) continue;
    if (alg === 'ES256' && jwk.crv !== 'P-256') continue;
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    if (jwk.alg !== undefined && jwk.alg !== alg) continue;
    if (kid !== undefined && jwk.kid !== kid) continue;
    const key = publicKeyFrom(jwk);
    if (key === null) continue;
    try {
      const ok =
        alg === 'ES256'
          ? cryptoVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature)
          : cryptoVerify('sha256', data, key, signature);
      if (ok) return true;
    } catch {
      // A malformed signature for this key is simply a failed candidate.
    }
  }
  return false;
}

export function verifyAccessToken(token: string, config: TokenConfig, nowUtc: string): TokenResult {
  const fail = (reason: string): TokenResult => ({ ok: false, reason });

  if (config.hmacSecret === '') throw new TypeError('hmacSecret must not be empty');
  if (typeof config.issuer !== 'string' || config.issuer.length === 0) {
    throw new TypeError('issuer must be a non-empty string');
  }
  const nowSec = epochSeconds(nowUtc);

  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return fail('malformed token');
  }
  const parts = token.split('.');
  if (parts.length !== 3) return fail('malformed token');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const headerBytes = decodeSegment(headerB64);
  const payloadBytes = decodeSegment(payloadB64);
  const signature = decodeSegment(signatureB64);
  if (headerBytes === null || payloadBytes === null || signature === null || signature.length === 0) {
    return fail('malformed token');
  }

  const header = parseJsonObject(headerBytes);
  if (header === null || typeof header.alg !== 'string') return fail('malformed header');
  if (header.kid !== undefined && typeof header.kid !== 'string') return fail('malformed header');
  const kid = typeof header.kid === 'string' ? header.kid : undefined;

  const signingInput = `${headerB64}.${payloadB64}`;
  const alg = header.alg;
  let signatureOk: boolean;
  if (alg === 'HS256') {
    if (config.hmacSecret === undefined) return fail('algorithm not enabled');
    signatureOk = verifyHmac(config.hmacSecret, signingInput, signature);
  } else if (alg === 'ES256' || alg === 'RS256') {
    signatureOk = verifyWithPublicKeys(alg, kid, signingInput, signature, config.publicKeys ?? []);
  } else {
    // Covers "none" and any algorithm this service does not accept.
    return fail('algorithm not allowed');
  }
  if (!signatureOk) return fail('bad signature');

  const payload = parseJsonObject(payloadBytes);
  if (payload === null) return fail('malformed payload');

  if (!isInteger(payload.exp)) return fail('missing exp');
  if (nowSec >= payload.exp) return fail('expired');

  if (payload.nbf !== undefined) {
    if (!isInteger(payload.nbf)) return fail('malformed nbf');
    if (nowSec < payload.nbf) return fail('not yet valid');
  }

  if (!isInteger(payload.iat)) return fail('missing iat');
  if (payload.iat > nowSec + MAX_FUTURE_IAT_SECONDS) return fail('issued in the future');

  if (payload.iss !== config.issuer) return fail('wrong issuer');
  if (payload.aud !== AUDIENCE) return fail('wrong audience');
  if (payload.role !== SUBJECT_ROLE) return fail('wrong role');

  if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) return fail('malformed subject');
  if (payload.aal !== undefined && typeof payload.aal !== 'string') return fail('malformed aal');
  if (payload.email !== undefined && typeof payload.email !== 'string') return fail('malformed email');

  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const claims: VerifiedClaims = {
    sub: payload.sub,
    aal: typeof payload.aal === 'string' ? payload.aal : undefined,
    iat: payload.iat,
    exp: payload.exp,
    ...(email !== undefined ? { email } : {}),
  };
  return { ok: true, claims };
}

// Builds an Actor from verified claims and the role read from the profiles table.
// The database role is authoritative. A null or unknown role denies the request.
export function actorFromVerifiedClaims(
  claims: VerifiedClaims,
  roleFromDatabase: Role | null,
  nowUtc: string,
  policy: ActorPolicy,
): Actor | null {
  if (
    typeof policy !== 'object' ||
    policy === null ||
    !Number.isInteger(policy.maxStaffSessionSeconds) ||
    policy.maxStaffSessionSeconds <= 0
  ) {
    throw new TypeError('policy.maxStaffSessionSeconds must be a positive integer');
  }
  if (roleFromDatabase === null || !ROLES.includes(roleFromDatabase)) return null;

  const aal2 = claims.aal === 'aal2';
  if (roleFromDatabase === 'customer') {
    return { kind: 'user', userId: claims.sub, role: 'customer', mfa: aal2 };
  }

  // Staff MFA counts only while the session is fresh. A session started longer ago than the policy
  // allows is still returned as an actor, but without mfa, so authorise() denies staff-only actions.
  const sessionAgeSeconds = epochSeconds(nowUtc) - claims.iat;
  const fresh = sessionAgeSeconds <= policy.maxStaffSessionSeconds;
  return { kind: 'user', userId: claims.sub, role: roleFromDatabase, mfa: aal2 && fresh };
}
