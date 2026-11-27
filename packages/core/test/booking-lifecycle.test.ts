import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import {
  BOOKING_STATES,
  BOOKING_TRANSITIONS,
  STAGE_OF,
  LOCKED_STATES,
  TICKETS_VISIBLE_STATES,
  REMITTANCE_STATUSES,
  REMITTANCE_TRANSITIONS,
  CONFIRMATION_PREREQUISITES,
  MONEY_FLOWS,
  canCapture,
  canConfirm,
  canRemittanceTransition,
  canTransition,
  transition,
  milestoneProblems,
  assertPartnerFunded,
  ticketsVisible,
  type BookingState,
  type MilestoneRecord,
  type RemittanceStatus,
} from '../src/booking-lifecycle.ts';
import { customerStatus } from '../../fulfilment/src/status.ts';
import { render, migrationPath } from '../../../scripts/generate-booking-lifecycle-sql.mjs';

const ALL = new Set<BookingState>(BOOKING_STATES);

// Milestones for a booking that has reached the verified stage, as the database would hold them.
const VERIFIED_MILESTONES: MilestoneRecord = {
  quoted_at: 't1',
  authorised_at: 't2',
  partner_order_confirmed_at: 't3',
  tickets_issued_at: 't4',
  tickets_verified_at: 't5',
};

// Milestones for a booking that has been captured. Confirmation needs nothing beyond this.
const CAPTURED_MILESTONES: MilestoneRecord = { ...VERIFIED_MILESTONES, captured_at: 't6' };

describe('one state vocabulary', () => {
  test('every state has a stage, a transition row and is reachable from draft', () => {
    for (const state of BOOKING_STATES) {
      assert.ok(state in STAGE_OF, `${state} has no stage`);
      assert.ok(state in BOOKING_TRANSITIONS, `${state} has no transition row`);
    }
    const reached = new Set<BookingState>(['draft']);
    const queue: BookingState[] = ['draft'];
    while (queue.length > 0) {
      const from = queue.shift() as BookingState;
      for (const to of BOOKING_TRANSITIONS[from]) {
        if (!reached.has(to)) {
          reached.add(to);
          queue.push(to);
        }
      }
    }
    assert.equal(reached.size, BOOKING_STATES.length, 'every state must be reachable from draft');
  });

  test('every transition target is a known state', () => {
    for (const targets of Object.values(BOOKING_TRANSITIONS)) {
      for (const to of targets) assert.ok(ALL.has(to), `unknown target ${to}`);
    }
  });

  test('the booking has 20 states and the transition table has 55 permitted pairs', () => {
    assert.equal(BOOKING_STATES.length, 20);
    const pairs = Object.values(BOOKING_TRANSITIONS).reduce((n, targets) => n + targets.length, 0);
    assert.equal(pairs, 55);
  });

  test('terminal states have no exits', () => {
    for (const state of ['failed', 'expired', 'refunded'] as const) {
      assert.deepEqual(BOOKING_TRANSITIONS[state], []);
    }
  });

  test('partner remittance is not a booking state, apart from the shared word "failed" (a known naming overlap)', () => {
    // 'failed' is both a booking state and a remittance status. They live in different columns, so they cannot be
    // confused by the database. Code must read the remittance status from partner_remittances.status only.
    const shared = REMITTANCE_STATUSES.filter((status) => ALL.has(status as BookingState));
    assert.deepEqual(shared, ['failed']);
    assert.equal(ALL.has('partner_remitted' as BookingState), false, 'partner_remitted must not be a booking state');
  });
});

describe('approved sequence', () => {
  test('the happy path moves in the approved order, one step at a time', () => {
    const path: BookingState[] = [
      'draft',
      'quoted',
      'authorised',
      'partner_ordered',
      'ticketing_pending',
      'tickets_issued',
      'verified',
      'captured',
      'confirmed',
    ];
    for (let i = 1; i < path.length; i += 1) {
      assert.equal(canTransition(path[i - 1], path[i]), true, `${path[i - 1]} -> ${path[i]} must be allowed`);
    }
  });

  test('capture cannot happen before GO verification', () => {
    assert.equal(canTransition('tickets_issued', 'captured'), false);
    assert.equal(canTransition('partner_ordered', 'captured'), false);
    assert.equal(canTransition('quoted', 'captured'), false);
  });

  test('confirmation follows capture and verification only', () => {
    assert.equal(canTransition('captured', 'confirmed'), true);
    assert.equal(canTransition('verified', 'confirmed'), false, 'no confirmation without capture');
    assert.equal(canTransition('tickets_issued', 'confirmed'), false, 'no confirmation without verification');
    assert.equal(canTransition('authorised', 'confirmed'), false, 'never straight from authorised');
  });

  test('a booking cannot skip from draft to a later stage', () => {
    assert.equal(canTransition('draft', 'verified'), false);
    assert.equal(canTransition('draft', 'authorised'), false);
    assert.throws(() => transition('draft', 'captured'), RangeError);
  });

  test('failed and expired bookings cannot be re-opened', () => {
    assert.equal(canTransition('failed', 'quoted'), false);
    assert.equal(canTransition('expired', 'quoted'), false);
  });

  test('locked states may only be reconciled, never sent again automatically', () => {
    assert.deepEqual([...LOCKED_STATES].sort(), ['order_unknown', 'ticketing_unknown']);
    assert.equal(canTransition('order_unknown', 'tickets_issued'), false);
    assert.equal(canTransition('ticketing_unknown', 'captured'), false);
  });
});

describe('gates', () => {
  test('canCapture requires a verified booking and a recorded verification', () => {
    assert.equal(canCapture('verified', VERIFIED_MILESTONES), true);
    assert.equal(canCapture('verified', { ...VERIFIED_MILESTONES, tickets_verified_at: null }), false);
    assert.equal(canCapture('tickets_issued', VERIFIED_MILESTONES), false);
  });

  test('canConfirm needs verification and capture, and nothing about remittance', () => {
    assert.equal(canConfirm('captured', CAPTURED_MILESTONES), true);
    assert.equal(canConfirm('verified', VERIFIED_MILESTONES), false, 'capture is missing');
    assert.equal(canConfirm('captured', { ...CAPTURED_MILESTONES, tickets_verified_at: null }), false, 'verification is missing');
    assert.equal(canConfirm('partner_ordered', CAPTURED_MILESTONES), false, 'the state must be captured');
  });

  test('a booking confirms after verification and capture even when remittance is pending or not required', () => {
    // Remittance is not a milestone and is not an input to canConfirm. These two cases must both confirm.
    const milestones: MilestoneRecord = { ...CAPTURED_MILESTONES };
    assert.equal(canConfirm('captured', milestones), true, 'remittance pending or not required: confirms');
    assert.equal('partner_remitted_at' in milestones, false, 'there is no remittance milestone');
  });

  test('confirmation needs each of its prerequisites: verification and capture', () => {
    for (const missing of CONFIRMATION_PREREQUISITES) {
      assert.equal(canConfirm('captured', { ...CAPTURED_MILESTONES, [missing]: null }), false, `${missing} must be required`);
    }
  });

  test('the confirmation prerequisites exclude remittance and provider settlement', () => {
    assert.deepEqual([...CONFIRMATION_PREREQUISITES].sort(), ['captured_at', 'tickets_verified_at']);
    assert.equal(CONFIRMATION_PREREQUISITES.some((m) => /remit|settle/.test(m)), false);
  });
});

describe('partner remittance (separate record and statuses)', () => {
  test('the remittance statuses are exactly the five agreed ones', () => {
    assert.deepEqual([...REMITTANCE_STATUSES], ['not_required', 'pending', 'paid', 'failed', 'under_review']);
  });

  test('paid and not_required are terminal', () => {
    assert.deepEqual(REMITTANCE_TRANSITIONS.paid, []);
    assert.deepEqual(REMITTANCE_TRANSITIONS.not_required, []);
  });

  test('a pending remittance can be paid, fail or go under review', () => {
    assert.equal(canRemittanceTransition('pending', 'paid'), true);
    assert.equal(canRemittanceTransition('pending', 'failed'), true);
    assert.equal(canRemittanceTransition('pending', 'under_review'), true);
  });

  test('a paid remittance cannot be reopened, and no status is reached from not_required', () => {
    assert.equal(canRemittanceTransition('paid', 'pending'), false);
    for (const from of REMITTANCE_STATUSES) {
      assert.equal(canRemittanceTransition(from, 'not_required'), false, `${from} -> not_required`);
    }
  });

  test('a failed or reviewed remittance can be retried or resolved, and every status is reachable', () => {
    assert.equal(canRemittanceTransition('failed', 'pending'), true);
    assert.equal(canRemittanceTransition('under_review', 'paid'), true);
    const reached = new Set<RemittanceStatus>();
    for (const targets of Object.values(REMITTANCE_TRANSITIONS)) for (const t of targets) reached.add(t);
    assert.ok(reached.has('paid') && reached.has('pending') && reached.has('failed') && reached.has('under_review'));
  });

  test('remittance is described as a partner-agreement obligation, never as GO financing issuance', () => {
    assert.match(MONEY_FLOWS.partnerRemittance, /never gates a booking/);
    assert.match(MONEY_FLOWS.partnerRemittance, /partner agreement/);
    assert.doesNotMatch(MONEY_FLOWS.partnerRemittance, /fund/i);
  });
});

describe('milestones', () => {
  test('a verified booking needs every earlier milestone', () => {
    assert.deepEqual(milestoneProblems('verified', VERIFIED_MILESTONES), []);
    const missing = milestoneProblems('verified', { ...VERIFIED_MILESTONES, authorised_at: null });
    assert.ok(missing.some((p) => p.includes('authorised_at')));
  });

  test('a confirmed booking needs capture and verification', () => {
    assert.deepEqual(milestoneProblems('confirmed', { ...CAPTURED_MILESTONES, confirmed_at: 't7' }), []);
    assert.ok(milestoneProblems('confirmed', { ...VERIFIED_MILESTONES, confirmed_at: 't7' }).some((p) => p.includes('captured_at')));
  });

  test('a later milestone cannot exist without an earlier one', () => {
    const problems = milestoneProblems('quoted', { quoted_at: 't1', tickets_issued_at: 't4' });
    assert.ok(problems.some((p) => p.includes('tickets_issued_at is set without')));
  });

  test('a draft booking needs no milestones', () => {
    assert.deepEqual(milestoneProblems('draft', {}), []);
  });
});

describe('funding', () => {
  test('only the partner-funded model is accepted', () => {
    assert.doesNotThrow(() => assertPartnerFunded('partner_funded'));
    assert.throws(() => assertPartnerFunded('go_funded'), RangeError);
    assert.throws(() => assertPartnerFunded(''), RangeError);
  });
});

describe('customer view', () => {
  test('tickets are not shown until GO has verified them', () => {
    assert.equal(ticketsVisible('tickets_issued'), false);
    assert.equal(customerStatus('tickets_issued').showTickets, false);
    assert.equal(customerStatus('verified').showTickets, true);
  });

  test('only verified, captured and confirmed bookings show tickets', () => {
    assert.deepEqual([...TICKETS_VISIBLE_STATES], ['verified', 'captured', 'confirmed']);
    for (const state of BOOKING_STATES) {
      assert.equal(customerStatus(state).showTickets, TICKETS_VISIBLE_STATES.includes(state), `${state} ticket visibility`);
    }
  });

  test('the pre-verification copy says the tickets are not yet valid', () => {
    assert.match(customerStatus('tickets_issued').detail, /not valid for travel until we have verified/);
  });

  test('only a confirmed booking is shown as confirmed', () => {
    for (const state of BOOKING_STATES) {
      const view = customerStatus(state);
      if (view.headline === 'Booking confirmed') {
        assert.equal(state, 'confirmed', `${state} must not claim confirmation`);
      }
    }
    assert.equal(customerStatus('captured').headline.includes('confirmed'), false);
  });
});

describe('database agreement', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  test('the committed migration is generated from the current TypeScript sources', () => {
    assert.equal(sql, render(), 'run: node scripts/generate-booking-lifecycle-sql.mjs');
  });

  test('the generator check passes on the committed file', () => {
    const out = execFileSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/generate-booking-lifecycle-sql.mjs', '--check'], {
      cwd: new URL('../../..', import.meta.url).pathname,
      encoding: 'utf8',
    });
    assert.match(out, /up to date/);
  });

  test('the database booking transition function lists exactly the TypeScript transitions', () => {
    const fn = sql.slice(sql.indexOf('create or replace function public.booking_transition_allowed'));
    const body = fn.slice(0, fn.indexOf('$$;', fn.indexOf('$$') + 2));
    const pairs = [...body.matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    const expected = Object.entries(BOOKING_TRANSITIONS)
      .flatMap(([from, targets]) => targets.map((to) => `${from}>${to}`))
      .sort();
    assert.deepEqual(pairs, expected);
  });

  test('the database remittance transition function lists exactly the TypeScript remittance transitions', () => {
    const fn = sql.slice(sql.indexOf('create or replace function public.remittance_transition_allowed'));
    const body = fn.slice(0, fn.indexOf('$$;', fn.indexOf('$$') + 2));
    const pairs = [...body.matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    const expected = Object.entries(REMITTANCE_TRANSITIONS)
      .flatMap(([from, targets]) => targets.map((to) => `${from}>${to}`))
      .sort();
    assert.deepEqual(pairs, expected);
  });

  test('the database stage function matches STAGE_OF', () => {
    const start = sql.indexOf('create or replace function public.booking_stage');
    const block = sql.slice(start, sql.indexOf('$$', sql.indexOf('as $$', start) + 5));
    const cases = new Map([...block.matchAll(/when '([a-z_]+)' then (\d+)/g)].map((m) => [m[1], Number(m[2])]));
    for (const state of BOOKING_STATES) assert.equal(cases.get(state), STAGE_OF[state], `stage of ${state}`);
  });

  test('the database ticket policy lists exactly the TypeScript visible states', () => {
    const start = sql.indexOf('b.booking_status in (');
    const list = sql.slice(start, sql.indexOf(')', start));
    const states = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(states, [...TICKETS_VISIBLE_STATES]);
  });

  test('the database remittance status check lists exactly the TypeScript statuses', () => {
    const match = sql.match(/partner_remittances \(\s*[\s\S]*?status\s+text not null check \(status in \(([^)]*)\)\)/);
    assert.ok(match, 'remittance status check not found');
    const statuses = [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(statuses, [...REMITTANCE_STATUSES]);
  });

  test('the migration has no partner_remitted booking state and no partner_remitted_at milestone', () => {
    assert.equal(sql.includes('partner_remitted'), false);
  });

  test('the currency reference holds the 155 current ordinary currencies', () => {
    const rows = [...sql.matchAll(/^  \('([A-Z]{3})', \d+, '(current|legacy)'/gm)];
    assert.equal(rows.length, 161);
    assert.equal(rows.filter((r) => r[2] === 'current').length, 155);
    assert.ok(rows.some((r) => r[1] === 'HRK' && r[2] === 'legacy'));
    assert.ok(!rows.some((r) => r[1] === 'UYW'), 'fund codes must not be in the currency reference');
  });
});
