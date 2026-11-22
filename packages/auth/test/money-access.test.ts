// Authorisation for money-moving actions. Deny by default; each allowance is named explicitly.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { authorise, AccessDenied, actorLabel, type Actor, type MoneyAction } from '../src/actor.ts';

const ALICE = 'cust-alice';
const customer: Actor = { kind: 'user', userId: ALICE, role: 'customer', mfa: false };
const supportMfa: Actor = { kind: 'user', userId: 'staff-1', role: 'support', mfa: true };
const supportNoMfa: Actor = { kind: 'user', userId: 'staff-1', role: 'support', mfa: false };
const adminMfa: Actor = { kind: 'user', userId: 'admin-1', role: 'admin', mfa: true };
const adminNoMfa: Actor = { kind: 'user', userId: 'admin-1', role: 'admin', mfa: false };

const ALL: readonly MoneyAction[] = ['payment.start', 'payment.capture', 'payment.release', 'payment.refund', 'fulfilment.order', 'fulfilment.poll', 'fulfilment.cancel'];

function allowed(actor: Actor, action: MoneyAction, owner?: string): boolean {
  try { authorise(actor, action, owner); return true; } catch (error) { assert.ok(error instanceof AccessDenied); return false; }
}

describe('service identities', () => {
  test('each service can perform exactly its own actions', () => {
    const payments: Actor = { kind: 'system', service: 'payments' };
    const fulfilment: Actor = { kind: 'system', service: 'fulfilment' };
    const worker: Actor = { kind: 'system', service: 'worker' };
    assert.equal(allowed(payments, 'payment.start'), true);
    assert.equal(allowed(payments, 'payment.capture'), false);
    assert.equal(allowed(fulfilment, 'payment.capture'), true);
    assert.equal(allowed(fulfilment, 'fulfilment.order'), true);
    assert.equal(allowed(worker, 'fulfilment.poll'), true);
    assert.equal(allowed(worker, 'fulfilment.order'), false);
    assert.equal(allowed(worker, 'payment.capture'), false);
    assert.equal(allowed(payments, 'fulfilment.cancel'), false);
  });
});

describe('customers', () => {
  test('a customer may start a payment only on their own booking', () => {
    assert.equal(allowed(customer, 'payment.start', ALICE), true);
    assert.equal(allowed(customer, 'payment.start', 'cust-bob'), false);
    assert.equal(allowed(customer, 'payment.start'), false, 'no owner means no access');
  });

  test('a customer can never capture, release, refund, order, poll or cancel', () => {
    for (const action of ALL.filter((a) => a !== 'payment.start')) {
      assert.equal(allowed(customer, action, ALICE), false, action);
    }
  });
});

describe('staff', () => {
  test('staff without a multi-factor session cannot cancel or refund', () => {
    assert.equal(allowed(supportNoMfa, 'fulfilment.cancel'), false);
    assert.equal(allowed(adminNoMfa, 'payment.refund'), false);
  });

  test('a support agent with MFA may cancel, but may not refund', () => {
    assert.equal(allowed(supportMfa, 'fulfilment.cancel'), true);
    assert.equal(allowed(supportMfa, 'payment.refund'), false);
  });

  test('an admin with MFA may refund; no staff role may capture or release money directly', () => {
    assert.equal(allowed(adminMfa, 'payment.refund'), true);
    assert.equal(allowed(adminMfa, 'payment.capture'), false);
    assert.equal(allowed(adminMfa, 'payment.release'), false);
    assert.equal(allowed(supportMfa, 'payment.start', 'staff-1'), false);
  });
});

describe('labels', () => {
  test('audit labels identify the actor without personal data', () => {
    assert.equal(actorLabel({ kind: 'system', service: 'payments' }), 'system:payments');
    assert.equal(actorLabel(customer), `user:${ALICE}`);
  });
});
