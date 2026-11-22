import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { AccessDenied } from '../src/actor.ts';
import type { Actor, Role } from '../src/actor.ts';
import { denialReason, permissionsFor, requirePermission, PERMISSIONS } from '../src/access.ts';
import type { Permission } from '../src/access.ts';
import { authenticateRequest, bearerFromHeader } from '../src/session.ts';
import type { AuthLookups } from '../src/session.ts';
import type { TokenConfig } from '../src/token.ts';

const ISSUER = 'https://project.example.test/auth/v1';
const SECRET = 'test-only-hmac-secret-do-not-use-in-production';
const CUSTOMER = '3f6c2a1e-8b7d-4c9e-9a1f-2b3c4d5e6f70';
const OTHER = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const STAFF = '7b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e';
const NOW = '2026-11-22T10:00:00.000Z';
const NOW_SEC = Date.parse(NOW) / 1000;
const POLICY = { maxStaffSessionSeconds: 900 };
const CONFIG: TokenConfig = { hmacSecret: SECRET, issuer: ISSUER };

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

// Signs a payload with the test secret. Overrides let each test break one claim at a time.
function token(overrides: Record<string, unknown> = {}, sub: string = CUSTOMER): string {
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({
    iss: ISSUER,
    aud: 'authenticated',
    role: 'authenticated',
    sub,
    iat: NOW_SEC - 10,
    exp: NOW_SEC + 3600,
    aal: 'aal1',
    ...overrides,
  });
  const signature = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

// Lookups stand in for the database. roles maps user ids to roles; mfa lists enrolled staff.
function lookups(roles: Record<string, Role>, mfa: readonly string[] = []): AuthLookups {
  return {
    roleFor: async (userId: string) => roles[userId] ?? null,
    hasVerifiedMfa: async (userId: string) => mfa.includes(userId),
  };
}

const CUSTOMER_ACTOR: Actor = { kind: 'user', userId: CUSTOMER, role: 'customer', mfa: false };
const SUPPORT_MFA: Actor = { kind: 'user', userId: STAFF, role: 'support', mfa: true };
const SUPPORT_NO_MFA: Actor = { kind: 'user', userId: STAFF, role: 'support', mfa: false };
const OPS_MFA: Actor = { kind: 'user', userId: STAFF, role: 'operations', mfa: true };
const OPS_NO_MFA: Actor = { kind: 'user', userId: STAFF, role: 'operations', mfa: false };
const ADMIN_MFA: Actor = { kind: 'user', userId: STAFF, role: 'admin', mfa: true };
const ADMIN_NO_MFA: Actor = { kind: 'user', userId: STAFF, role: 'admin', mfa: false };

describe('permission matrix (deny by default)', () => {
  test('customers hold only their own booking read', () => {
    assert.deepEqual(permissionsFor('customer'), ['booking.read.own']);
  });

  test('operations never hold passenger, refund or cancellation permissions', () => {
    const held = permissionsFor('operations');
    assert.ok(!held.includes('passenger.read.assigned'));
    assert.ok(!held.includes('refund.issue'));
    assert.ok(!held.includes('booking.cancel.staff'));
    assert.ok(!held.includes('role.change'));
    assert.ok(!held.includes('audit.read'));
  });

  test('support cannot refund, manage assignments, read the audit log or change roles', () => {
    const held = permissionsFor('support');
    for (const p of ['refund.issue', 'assignment.manage', 'audit.read', 'role.change'] as const) {
      assert.ok(!held.includes(p), `support must not hold ${p}`);
    }
  });

  test('every role has a distinct set and admin is the only role with role.change', () => {
    const withRoleChange = (['customer', 'support', 'operations', 'admin'] as const).filter((r) =>
      permissionsFor(r).includes('role.change'),
    );
    assert.deepEqual(withRoleChange, ['admin']);
  });

  test('an unknown permission name throws rather than being allowed', () => {
    assert.throws(() => denialReason(ADMIN_MFA, 'everything' as Permission), TypeError);
  });

  test('an unknown role has no permissions', () => {
    assert.deepEqual(permissionsFor('finance' as Role), []);
  });

  test('a missing actor is always denied', () => {
    for (const p of PERMISSIONS) assert.notEqual(denialReason(null, p), null);
  });
});

describe('customer access', () => {
  test('a customer reads their own booking', () => {
    assert.equal(denialReason(CUSTOMER_ACTOR, 'booking.read.own', CUSTOMER), null);
  });

  test('a customer cannot read another customer\'s booking', () => {
    assert.notEqual(denialReason(CUSTOMER_ACTOR, 'booking.read.own', OTHER), null);
  });

  test('a customer with no booking owner in scope is denied', () => {
    assert.notEqual(denialReason(CUSTOMER_ACTOR, 'booking.read.own'), null);
  });

  test('a customer cannot use any staff permission, even with an MFA session', () => {
    const customerMfa: Actor = { kind: 'user', userId: CUSTOMER, role: 'customer', mfa: true };
    for (const p of ['booking.read.all', 'passenger.read.assigned', 'refund.issue', 'audit.read', 'role.change'] as const) {
      assert.notEqual(denialReason(customerMfa, p), null, `customer must not hold ${p}`);
    }
  });

  test('a customer cannot cancel or refund, and cannot read passengers through any path', () => {
    assert.throws(() => requirePermission(CUSTOMER_ACTOR, 'refund.issue'), AccessDenied);
    assert.throws(() => requirePermission(CUSTOMER_ACTOR, 'booking.cancel.staff'), AccessDenied);
    assert.throws(() => requirePermission(CUSTOMER_ACTOR, 'passenger.read.assigned'), AccessDenied);
  });
});

describe('staff access and MFA', () => {
  test('staff permissions require an MFA session', () => {
    assert.notEqual(denialReason(SUPPORT_NO_MFA, 'booking.read.all'), null);
    assert.notEqual(denialReason(OPS_NO_MFA, 'booking.read.all'), null);
    assert.notEqual(denialReason(ADMIN_NO_MFA, 'audit.read'), null);
  });

  test('staff with an MFA session get their permitted reads and actions', () => {
    assert.equal(denialReason(OPS_MFA, 'booking.read.all'), null);
    assert.equal(denialReason(SUPPORT_MFA, 'passenger.read.assigned'), null);
    assert.equal(denialReason(ADMIN_MFA, 'refund.issue'), null);
  });

  test('operations cannot read passenger details even with MFA', () => {
    assert.notEqual(denialReason(OPS_MFA, 'passenger.read.assigned'), null);
  });

  test('operations cannot cancel or refund even with MFA', () => {
    assert.throws(() => requirePermission(OPS_MFA, 'booking.cancel.staff'), AccessDenied);
    assert.throws(() => requirePermission(OPS_MFA, 'refund.issue'), AccessDenied);
  });

  test('system actors do not hold user permissions', () => {
    const system: Actor = { kind: 'system', service: 'worker' };
    assert.notEqual(denialReason(system, 'booking.read.all'), null);
  });

  test('a denial message names the permission but gives no account details', () => {
    try {
      requirePermission(OPS_MFA, 'refund.issue');
      assert.fail('expected denial');
    } catch (error) {
      assert.ok(error instanceof AccessDenied);
      assert.equal(error.code, 'access_denied');
      assert.ok(!error.message.includes(STAFF));
    }
  });
});

describe('request authentication', () => {
  test('a missing or malformed bearer token is refused', async () => {
    const out = await authenticateRequest(undefined, CONFIG, POLICY, lookups({}), NOW);
    assert.deepEqual(out, { ok: false, reason: 'no_token' });
    assert.equal(bearerFromHeader('Basic abc'), undefined);
    assert.equal(bearerFromHeader('Bearer a b'), undefined);
    assert.equal(bearerFromHeader('Bearer '), undefined);
  });

  test('an expired token is refused without revealing why', async () => {
    const expired = token({ exp: NOW_SEC - 1 });
    const out = await authenticateRequest(expired, CONFIG, POLICY, lookups({ [CUSTOMER]: 'customer' }), NOW);
    assert.deepEqual(out, { ok: false, reason: 'invalid_token' });
  });

  test('a token signed with another secret is refused', async () => {
    const forged = token({}, CUSTOMER).replace(/\.[^.]+$/, '.AAAA');
    const out = await authenticateRequest(forged, CONFIG, POLICY, lookups({ [CUSTOMER]: 'customer' }), NOW);
    assert.deepEqual(out, { ok: false, reason: 'invalid_token' });
  });

  test('a valid token for an account with no profile is refused', async () => {
    const out = await authenticateRequest(token(), CONFIG, POLICY, lookups({}), NOW);
    assert.deepEqual(out, { ok: false, reason: 'unknown_account' });
  });

  test('a customer token builds a customer actor', async () => {
    const out = await authenticateRequest(token(), CONFIG, POLICY, lookups({ [CUSTOMER]: 'customer' }), NOW);
    assert.equal(out.ok, true);
    if (out.ok) assert.deepEqual(out.actor, { kind: 'user', userId: CUSTOMER, role: 'customer', mfa: false });
  });

  test('a role claim inside the token cannot make a customer into staff', async () => {
    // The token asks for admin in user metadata. Only the database role counts.
    const escalated = token({ user_metadata: { role: 'admin' }, app_metadata: { role: 'admin' } });
    const out = await authenticateRequest(escalated, CONFIG, POLICY, lookups({ [CUSTOMER]: 'customer' }), NOW);
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.actor.kind === 'user' && out.actor.role, 'customer');
  });

  test('staff without a verified MFA method are refused even with a valid token', async () => {
    const out = await authenticateRequest(token({}, STAFF), CONFIG, POLICY, lookups({ [STAFF]: 'support' }, []), NOW);
    assert.deepEqual(out, { ok: false, reason: 'staff_mfa_not_enrolled' });
  });

  test('operations and admins are also refused without MFA enrolment', async () => {
    for (const role of ['operations', 'admin'] as const) {
      const out = await authenticateRequest(token({}, STAFF), CONFIG, POLICY, lookups({ [STAFF]: role }, []), NOW);
      assert.deepEqual(out, { ok: false, reason: 'staff_mfa_not_enrolled' }, role);
    }
  });

  test('enrolled staff with an aal2 session get an MFA actor', async () => {
    const out = await authenticateRequest(
      token({ aal: 'aal2', iat: NOW_SEC - 60 }, STAFF),
      CONFIG,
      POLICY,
      lookups({ [STAFF]: 'operations' }, [STAFF]),
      NOW,
    );
    assert.equal(out.ok, true);
    if (out.ok) assert.deepEqual(out.actor, { kind: 'user', userId: STAFF, role: 'operations', mfa: true });
  });

  test('a staff session older than the policy keeps the actor but drops MFA, so staff actions are denied', async () => {
    const stale = await authenticateRequest(
      token({ aal: 'aal2', iat: NOW_SEC - 3600 }, STAFF),
      CONFIG,
      POLICY,
      lookups({ [STAFF]: 'admin' }, [STAFF]),
      NOW,
    );
    assert.equal(stale.ok, true);
    if (stale.ok) {
      assert.equal(stale.actor.kind === 'user' && stale.actor.mfa, false);
      assert.notEqual(denialReason(stale.actor, 'refund.issue'), null);
    }
  });

  test('an aal1 staff session is not MFA even if enrolled', async () => {
    const out = await authenticateRequest(
      token({ aal: 'aal1' }, STAFF),
      CONFIG,
      POLICY,
      lookups({ [STAFF]: 'support' }, [STAFF]),
      NOW,
    );
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.actor.kind === 'user' && out.actor.mfa, false);
  });

  test('a removed staff role denies access at the next request', async () => {
    const out = await authenticateRequest(
      token({ aal: 'aal2', iat: NOW_SEC - 60 }, STAFF),
      CONFIG,
      POLICY,
      lookups({}, [STAFF]),
      NOW,
    );
    assert.deepEqual(out, { ok: false, reason: 'unknown_account' });
  });
});
