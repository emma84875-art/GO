import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideRequest,
  decideResetAction,
  decideRevocation,
  resetStatus,
  validateReason,
} from '../src/mfa-reset.ts';
import type { ResetRecord } from '../src/mfa-reset.ts';

const REQUESTER = '00000000-0000-0000-0000-00000000000e';
const VERIFIER = '00000000-0000-0000-0000-000000000007';
const TARGET = '00000000-0000-0000-0000-00000000000c';
const NOW = '2026-11-22T12:00:00.000Z';

function open(overrides: Partial<ResetRecord> = {}): ResetRecord {
  return {
    requestedBy: REQUESTER,
    targetUserId: TARGET,
    identityVerifiedBy: null,
    identityVerifiedAt: null,
    targetNotifiedAt: null,
    completedBy: null,
    completedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

const VERIFIED = open({ identityVerifiedBy: VERIFIER, identityVerifiedAt: NOW });
const NOTIFIED = open({ ...VERIFIED, targetNotifiedAt: NOW });

describe('reason', () => {
  test('a documented reason of 20 to 1000 characters is accepted', () => {
    assert.deepEqual(validateReason('Lost my authenticator device on travel'), { allowed: true });
  });

  test('short, blank and overlong reasons are refused', () => {
    assert.equal(validateReason('too short').allowed, false);
    assert.equal(validateReason('                    ').allowed, false);
    assert.equal(validateReason('x'.repeat(1001)).allowed, false);
  });
});

describe('request', () => {
  test('a super administrator may request a reset for a staff member', () => {
    assert.deepEqual(decideRequest(REQUESTER, TARGET, true, false), { allowed: true });
  });

  test('a super administrator cannot reset their own factor', () => {
    assert.equal(decideRequest(REQUESTER, REQUESTER, true, true).allowed, false);
  });

  test('a super administrator account cannot be the target of a staff reset', () => {
    const d = decideRequest(REQUESTER, VERIFIER, true, true);
    assert.equal(d.allowed, false);
    assert.match(d.allowed ? '' : d.reason, /separate procedure/);
  });

  test('a customer account cannot be the target of a staff reset', () => {
    assert.equal(decideRequest(REQUESTER, TARGET, false, false).allowed, false);
  });
});

describe('verify, complete and cancel', () => {
  test('only a super administrator in an MFA session may act', () => {
    assert.equal(decideResetAction(open(), 'verify', VERIFIER, false).allowed, false);
    assert.equal(decideResetAction(VERIFIED, 'complete', VERIFIER, false).allowed, false);
    assert.equal(decideResetAction(open(), 'cancel', VERIFIER, false).allowed, false);
  });

  test('the requester cannot verify their own request', () => {
    assert.equal(decideResetAction(open(), 'verify', REQUESTER, true).allowed, false);
  });

  test('a different super administrator can verify, once', () => {
    assert.equal(decideResetAction(open(), 'verify', VERIFIER, true).allowed, true);
    assert.equal(decideResetAction(VERIFIED, 'verify', VERIFIER, true).allowed, false);
  });

  test('completion needs the identity check and the notice', () => {
    const noVerify = decideResetAction(open(), 'complete', VERIFIER, true);
    assert.equal(noVerify.allowed, false);
    const noNotice = decideResetAction(VERIFIED, 'complete', VERIFIER, true);
    assert.equal(noNotice.allowed, false);
    assert.match(noNotice.allowed ? '' : noNotice.reason, /notified/);
    assert.equal(decideResetAction(NOTIFIED, 'complete', VERIFIER, true).allowed, true);
  });

  test('the requester cannot complete their own reset', () => {
    assert.equal(decideResetAction(NOTIFIED, 'complete', REQUESTER, true).allowed, false);
  });

  test('a closed reset cannot be acted on', () => {
    const completed = open({ ...NOTIFIED, completedBy: 'x', completedAt: NOW });
    assert.equal(resetStatus(completed), 'completed');
    assert.equal(decideResetAction(completed, 'cancel', VERIFIER, true).allowed, false);
    const cancelled = open({ cancelledAt: NOW });
    assert.equal(resetStatus(cancelled), 'cancelled');
    assert.equal(decideResetAction(cancelled, 'verify', VERIFIER, true).allowed, false);
  });

  test('an active super administrator can cancel an open reset, including the requester', () => {
    assert.equal(decideResetAction(open(), 'cancel', REQUESTER, true).allowed, true);
    assert.equal(decideResetAction(open(), 'cancel', VERIFIER, true).allowed, true);
  });
});

describe('super administrator minimum', () => {
  test('revoking when only two remain is refused', () => {
    assert.equal(decideRevocation(2).allowed, false);
  });

  test('revoking with three in place is allowed', () => {
    assert.equal(decideRevocation(3).allowed, true);
  });
});
