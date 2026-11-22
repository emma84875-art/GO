import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { LoginGuard, passwordIssues, publicMessageFor, PUBLIC_MESSAGES, PASSWORD_MAX_BYTES } from '../src/account-security.ts';
import type { LoginLimits } from '../src/account-security.ts';

// A clock the test controls, in milliseconds, for the fixed-window limiter.
function clock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const LIMITS: LoginLimits = {
  perAddress: { limit: 3, windowSeconds: 60 },
  perAccount: { limit: 2, windowSeconds: 60 },
};

describe('login throttling', () => {
  test('an account is locked after its limit, whichever address is used', () => {
    const c = clock(0);
    const guard = new LoginGuard(LIMITS, c.now);
    assert.equal(guard.attempt('10.0.0.1', 'Victim@Example.test').allowed, true);
    assert.equal(guard.attempt('10.0.0.2', 'victim@example.test').allowed, true);
    const third = guard.attempt('10.0.0.3', ' VICTIM@example.test ');
    assert.equal(third.allowed, false);
    if (!third.allowed) assert.ok(third.retryAfterSeconds >= 1);
  });

  test('an address is limited across many accounts (password spraying)', () => {
    const c = clock(0);
    const guard = new LoginGuard(LIMITS, c.now);
    assert.equal(guard.attempt('10.0.0.9', 'a@example.test').allowed, true);
    assert.equal(guard.attempt('10.0.0.9', 'b@example.test').allowed, true);
    assert.equal(guard.attempt('10.0.0.9', 'c@example.test').allowed, true);
    assert.equal(guard.attempt('10.0.0.9', 'd@example.test').allowed, false);
  });

  test('the window resets after it ends', () => {
    const c = clock(0);
    const guard = new LoginGuard(LIMITS, c.now);
    guard.attempt('10.0.0.1', 'x@example.test');
    guard.attempt('10.0.0.1', 'x@example.test');
    assert.equal(guard.attempt('10.0.0.1', 'x@example.test').allowed, false);
    c.advance(61_000);
    assert.equal(guard.attempt('10.0.0.1', 'x@example.test').allowed, true);
  });

  test('an unknown email is throttled exactly like a known one (no enumeration by timing or response)', () => {
    const c = clock(0);
    const guard = new LoginGuard(LIMITS, c.now);
    // The guard never looks up accounts, so the decisions for two emails depend only on the attempts.
    const known = [guard.attempt('10.1.1.1', 'real@example.test'), guard.attempt('10.1.1.2', 'real@example.test'), guard.attempt('10.1.1.3', 'real@example.test')];
    const unknown = [guard.attempt('10.2.2.1', 'nobody@example.test'), guard.attempt('10.2.2.2', 'nobody@example.test'), guard.attempt('10.2.2.3', 'nobody@example.test')];
    assert.deepEqual(known.map((d) => d.allowed), unknown.map((d) => d.allowed));
  });

  test('a missing address or a non-string email is refused as a programming error', () => {
    const guard = new LoginGuard(LIMITS);
    assert.throws(() => guard.attempt('', 'x@example.test'), TypeError);
    assert.throws(() => guard.attempt('10.0.0.1', 5 as unknown as string), TypeError);
  });
});

describe('password rules', () => {
  test('a short password is refused', () => {
    assert.deepEqual(passwordIssues('short-pass1', 'ada@example.test'), ['too_short']);
  });

  test('a password of exactly the minimum length is accepted', () => {
    assert.deepEqual(passwordIssues('correct-hors', 'ada@example.test'), []);
  });

  test('a blank or spaces-only password is refused', () => {
    assert.deepEqual(passwordIssues('            ', 'ada@example.test'), ['blank']);
  });

  test('a password containing the email name is refused', () => {
    assert.ok(passwordIssues('Ada-Lovelace-2026!', 'ada.lovelace@example.test').includes('contains_email_name'));
  });

  test('a password over the 72-byte bcrypt limit is refused', () => {
    const long = 'é'.repeat(40) + 'abcdefghijkl';
    assert.ok(Buffer.byteLength(long, 'utf8') > PASSWORD_MAX_BYTES);
    assert.ok(passwordIssues(long, 'ada@example.test').includes('too_long'));
  });
});

describe('public messages', () => {
  test('every internal authentication failure maps to a public message', () => {
    for (const internal of ['bad_credentials', 'unknown_account', 'throttled', 'staff_mfa_not_enrolled', 'mfa_failed', 'anything-else']) {
      const message = publicMessageFor(internal);
      assert.ok(Object.values(PUBLIC_MESSAGES).includes(message), internal);
    }
  });

  test('wrong email and wrong password look identical to the person', () => {
    assert.equal(publicMessageFor('bad_credentials'), publicMessageFor('unknown_account'));
  });

  test('no public message reveals token, role, signature or account internals', () => {
    const forbidden = /token|signature|role|expired|jwt|database|sql|profile|exists|registered/i;
    for (const message of Object.values(PUBLIC_MESSAGES)) {
      assert.ok(!forbidden.test(message) || message === PUBLIC_MESSAGES.recoveryRequested, message);
    }
  });

  test('password recovery says the same thing whether or not an account exists', () => {
    assert.equal(PUBLIC_MESSAGES.recoveryRequested, 'If an account exists for that email, we have sent a reset link.');
  });
});
