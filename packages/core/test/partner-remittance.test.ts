import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ADMIN_ONLY_REMITTANCE_STATUSES,
  REMITTANCE_INSERT_STATUSES,
  AGREEMENT_FIELDS,
  NO_OBLIGATION_EVIDENCE_MIN,
  REMITTANCE_RECORDS_PER_BOOKING,
  validateAgreementTerms,
  validateNoObligationRecord,
  remittanceChangeProblems,
  agreementCorrectionProblems,
  type PartnerAgreementTerms,
  type NoObligationRecord,
} from '../src/partner-remittance.ts';
import { REMITTANCE_STATUSES } from '../src/booking-lifecycle.ts';
import { migrationPath } from '../../../scripts/generate-booking-lifecycle-sql.mjs';

const TERMS: PartnerAgreementTerms = {
  reference: 'PA-2026-001',
  clause: 'Clause 4.2',
  amountMinor: 45000,
  currency: 'NGN',
  dueAtUtc: '2026-12-31T23:59:00Z',
};

const NO_OBLIGATION: NoObligationRecord = {
  agreementReference: 'PA-2026-002',
  agreementClause: 'Clause 9.1',
  approvedByAdministrator: true,
  approvedAtUtc: '2026-11-26T20:00:00Z',
  evidence: 'Agreement 9.1: no remittance is owed for ticket-only sales.',
};

describe('who may change a remittance', () => {
  test('finance staff may create a pending remittance, fail it with a reason, and retry it with a note', () => {
    assert.deepEqual(remittanceChangeProblems({ role: 'finance', from: null, to: 'pending' }), []);
    assert.deepEqual(remittanceChangeProblems({ role: 'finance', from: 'pending', to: 'failed', reason: 'Bank rejected' }), []);
    assert.deepEqual(remittanceChangeProblems({ role: 'finance', from: 'failed', to: 'pending', reason: 'Bank details corrected' }), []);
  });

  test('finance staff may move a remittance to under review with a reason', () => {
    assert.deepEqual(remittanceChangeProblems({ role: 'finance', from: 'pending', to: 'under_review', reason: 'Proof requested' }), []);
  });

  test('support and operations staff have no remittance access, for any change', () => {
    for (const role of ['support', 'operations'] as const) {
      assert.ok(remittanceChangeProblems({ role, from: null, to: 'pending' }).some((p) => p.includes('no partner remittance access')), role);
      assert.ok(remittanceChangeProblems({ role, from: 'pending', to: 'failed', reason: 'x' }).some((p) => p.includes('no partner remittance access')), role);
      assert.ok(remittanceChangeProblems({ role, from: 'failed', to: 'pending', reason: 'x' }).some((p) => p.includes('no partner remittance access')), role);
    }
  });

  test('only an administrator may mark a remittance paid, from pending or under review', () => {
    for (const role of ['finance', 'support', 'operations'] as const) {
      const problems = remittanceChangeProblems({ role, from: 'under_review', to: 'paid', reason: 'proof received' });
      assert.ok(problems.length > 0, `${role} must not mark paid`);
    }
    const adminProblems = remittanceChangeProblems({ role: 'finance', from: 'under_review', to: 'paid', reason: 'x' });
    assert.ok(adminProblems.some((p) => p.includes('only an administrator')), 'finance must not mark paid');
    assert.deepEqual(remittanceChangeProblems({ role: 'admin', from: 'under_review', to: 'paid', reason: 'proof received' }), []);
    assert.deepEqual(remittanceChangeProblems({ role: 'admin', from: 'pending', to: 'paid', reason: 'proof received' }), []);
  });

  test('only an administrator may record a remittance as not required', () => {
    for (const role of ['finance', 'support', 'operations'] as const) {
      assert.ok(remittanceChangeProblems({ role, from: null, to: 'not_required' }).length > 0, role);
    }
    assert.ok(remittanceChangeProblems({ role: 'finance', from: null, to: 'not_required' }).some((p) => p.includes('only an administrator')));
    assert.deepEqual(remittanceChangeProblems({ role: 'admin', from: null, to: 'not_required' }), []);
  });

  test('customers cannot change a remittance in any way', () => {
    assert.ok(remittanceChangeProblems({ role: 'customer', from: null, to: 'pending' }).some((p) => p.includes('customers')));
  });

  test('paid and not required are final, and no status returns to not required', () => {
    assert.ok(remittanceChangeProblems({ role: 'admin', from: 'paid', to: 'pending', reason: 'x' }).length > 0);
    assert.ok(remittanceChangeProblems({ role: 'admin', from: 'pending', to: 'not_required', reason: 'x' }).length > 0);
  });

  test('a failed or reviewed remittance cannot be retried without a note', () => {
    assert.ok(remittanceChangeProblems({ role: 'finance', from: 'failed', to: 'pending' }).some((p) => p.includes('recovery attempt')));
    assert.deepEqual(remittanceChangeProblems({ role: 'finance', from: 'failed', to: 'pending', reason: 'Bank details corrected' }), []);
  });

  test('failed and under review each need a reason', () => {
    assert.ok(remittanceChangeProblems({ role: 'finance', from: 'pending', to: 'failed' }).some((p) => p.includes('needs a reason')));
    assert.ok(remittanceChangeProblems({ role: 'finance', from: 'pending', to: 'under_review' }).some((p) => p.includes('needs a reason')));
  });

  test('a remittance can only be created as pending or not required', () => {
    assert.deepEqual([...REMITTANCE_INSERT_STATUSES].sort(), ['not_required', 'pending']);
    assert.ok(remittanceChangeProblems({ role: 'admin', from: null, to: 'paid', reason: 'x' }).some((p) => p.includes('cannot be created')));
  });

  test('the admin-only set is exactly paid and not required', () => {
    assert.deepEqual([...ADMIN_ONLY_REMITTANCE_STATUSES].sort(), ['not_required', 'paid']);
  });

  test('unknown statuses are refused', () => {
    assert.ok(remittanceChangeProblems({ role: 'admin', from: null, to: 'maybe' as never }).some((p) => p.includes('unknown')));
  });
});

describe('agreement terms come from the agreement', () => {
  test('a complete agreement is accepted', () => {
    assert.deepEqual(validateAgreementTerms(TERMS), []);
  });

  test('every term is required: reference, clause, amount, currency and due date', () => {
    assert.ok(validateAgreementTerms({ ...TERMS, reference: '' }).some((p) => p.includes('agreement reference')));
    assert.ok(validateAgreementTerms({ ...TERMS, clause: ' ' }).some((p) => p.includes('clause')));
    assert.ok(validateAgreementTerms({ ...TERMS, amountMinor: undefined }).some((p) => p.includes('agreed amount')));
    assert.ok(validateAgreementTerms({ ...TERMS, amountMinor: 1.5 }).some((p) => p.includes('agreed amount')));
    assert.ok(validateAgreementTerms({ ...TERMS, amountMinor: -1 }).some((p) => p.includes('agreed amount')));
    assert.ok(validateAgreementTerms({ ...TERMS, currency: 'naira' }).some((p) => p.includes('currency')));
    assert.ok(validateAgreementTerms({ ...TERMS, dueAtUtc: '' }).some((p) => p.includes('due date')));
    assert.ok(validateAgreementTerms({ ...TERMS, dueAtUtc: 'next Tuesday' }).some((p) => p.includes('due date')));
  });

  test('no deadline is hardcoded: a term set with no due date is refused', () => {
    const { dueAtUtc: _omitted, ...noDue } = TERMS;
    assert.ok(validateAgreementTerms(noDue).some((p) => p.includes('due date')));
  });

  test('the database sets no default for the due date, amount or currency', () => {
    const sql = readFileSync(migrationPath, 'utf8');
    const table = sql.slice(sql.indexOf('create table public.partner_remittances'), sql.indexOf('alter table public.partner_remittances enable'));
    assert.match(table, /due_at\s+timestamptz,/, 'due_at has no default');
    assert.match(table, /amount_minor\s+bigint check/, 'amount has no default');
    assert.match(table, /currency\s+char\(3\) references/, 'currency has no default');
    assert.equal(/due_at\s+timestamptz\s+default/.test(table), false);
  });

  test('the agreement fields are the ones a correction covers', () => {
    assert.deepEqual([...AGREEMENT_FIELDS], ['agreement_reference', 'agreement_clause', 'amount_minor', 'currency', 'due_at']);
  });
});

describe('not required needs auditable evidence', () => {
  test('a complete record with administrator approval is accepted', () => {
    assert.deepEqual(validateNoObligationRecord(NO_OBLIGATION), []);
  });

  test('approval by an administrator, the agreement reference, the clause and the time are all required', () => {
    assert.ok(validateNoObligationRecord({ ...NO_OBLIGATION, approvedByAdministrator: false }).some((p) => p.includes('administrator')));
    assert.ok(validateNoObligationRecord({ ...NO_OBLIGATION, agreementReference: '' }).some((p) => p.includes('agreement reference')));
    assert.ok(validateNoObligationRecord({ ...NO_OBLIGATION, agreementClause: '' }).some((p) => p.includes('clause')));
    assert.ok(validateNoObligationRecord({ ...NO_OBLIGATION, approvedAtUtc: '' }).some((p) => p.includes('approval time')));
  });

  test('evidence must say something: a short or blank note is refused', () => {
    assert.equal(NO_OBLIGATION_EVIDENCE_MIN, 20);
    assert.ok(validateNoObligationRecord({ ...NO_OBLIGATION, evidence: 'no fee' }).some((p) => p.includes('evidence')));
    assert.ok(validateNoObligationRecord({ ...NO_OBLIGATION, evidence: '' }).some((p) => p.includes('evidence')));
  });
});

describe('corrections and the limit of one record per booking', () => {
  test('only an administrator may correct agreement terms, and only with a reason', () => {
    for (const role of ['finance', 'support', 'operations'] as const) {
      assert.ok(agreementCorrectionProblems({ role, changedFields: ['amount_minor'], reason: 'x' }).length > 0, role);
    }
    assert.ok(agreementCorrectionProblems({ role: 'admin', changedFields: ['amount_minor'] }).some((p) => p.includes('reason')));
    assert.deepEqual(agreementCorrectionProblems({ role: 'admin', changedFields: ['amount_minor'], reason: 'confirmed by partner' }), []);
    assert.deepEqual(agreementCorrectionProblems({ role: 'finance', changedFields: [] }), []);
  });

  test('the model holds one remittance record per booking, so instalments are not representable', () => {
    assert.equal(REMITTANCE_RECORDS_PER_BOOKING, 1);
    const sql = readFileSync(migrationPath, 'utf8');
    assert.match(sql, /booking_id\s+uuid not null unique references public\.bookings/);
  });

  test('the remittance statuses are still the five agreed ones', () => {
    assert.deepEqual([...REMITTANCE_STATUSES], ['not_required', 'pending', 'paid', 'failed', 'under_review']);
  });
});

describe('database agreement for remittance rules', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  test('the database admin-only list equals the TypeScript list', () => {
    const line = sql.split('\n').find((l) => l.includes('new.status in (') && l.includes('and not v_admin'));
    assert.ok(line, 'admin-only check not found');
    const values = [...line.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(values, [...ADMIN_ONLY_REMITTANCE_STATUSES].sort());
  });

  test('the audit trail is append-only and the audit table exists', () => {
    assert.match(sql, /create table public\.partner_remittance_events/);
    assert.match(sql, /before update or delete on public\.partner_remittance_events/);
    assert.match(sql, /Partner remittance events are append-only/);
  });

  test('the remittance guards run with the owner\'s rights', () => {
    assert.match(sql, /function public\.guard_partner_remittance\(\)[\s\S]*?security definer/);
    assert.match(sql, /function public\.audit_partner_remittance\(\)[\s\S]*?security definer/);
  });
});
