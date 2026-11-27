// Service rules for partner remittance (Phase 19.1 amendment, docs/24 section 3A and docs/25).
//
// A remittance is GO's payment obligation to the ticketing partner under a partner agreement. It is tracked on its own
// record and never changes a booking. These rules decide who may change a remittance and what evidence each change needs.
// The database trigger (supabase/migrations/20261126000000_booking_lifecycle.sql) enforces the same rules. Tests compare them.
//
// No deadline is built in. Every due date, amount and currency comes from the partner agreement that the record cites.

import { REMITTANCE_STATUSES, REMITTANCE_TRANSITIONS, type RemittanceStatus } from './booking-lifecycle.ts';

// Only an administrator may move a remittance to these statuses, or record one with them.
export const ADMIN_ONLY_REMITTANCE_STATUSES: readonly RemittanceStatus[] = ['paid', 'not_required'];

// A remittance can be created in these statuses only. Paid, failed and under review are reached by change.
export const REMITTANCE_INSERT_STATUSES: readonly RemittanceStatus[] = ['pending', 'not_required'];

// Fields that come from the partner agreement. Changing one is a correction, which only an administrator may make.
export const AGREEMENT_FIELDS = ['agreement_reference', 'agreement_clause', 'amount_minor', 'currency', 'due_at'] as const;

export const NO_OBLIGATION_EVIDENCE_MIN = 20;

// Finance staff (with MFA) handle remittances across bookings. Support and operations have no remittance access.
export type StaffRole = 'customer' | 'support' | 'operations' | 'finance' | 'admin';

export interface PartnerAgreementTerms {
  readonly reference: string;     // the agreement's identifier, as held on file
  readonly clause: string;        // the clause that sets the amount, currency and due date
  readonly amountMinor: number;   // agreed amount, in the currency's minor units; never invented
  readonly currency: string;      // ISO 4217 code
  readonly dueAtUtc: string;      // due date from the agreement; there is no default
}

export interface NoObligationRecord {
  readonly agreementReference: string;
  readonly agreementClause: string;
  readonly approvedByAdministrator: boolean;
  readonly approvedAtUtc: string;
  readonly evidence: string;      // why no remittance is owed under the agreement
}

const ISO_CURRENCY = /^[A-Z]{3}$/;

function isValidInstant(value: string): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

// Agreement terms are required for every remittance record, including a not-required one that cites its agreement.
export function validateAgreementTerms(terms: Partial<PartnerAgreementTerms>): string[] {
  const problems: string[] = [];
  if (!terms.reference || terms.reference.trim().length === 0 || terms.reference.length > 120) {
    problems.push('the partner agreement reference is required (up to 120 characters)');
  }
  if (!terms.clause || terms.clause.trim().length === 0 || terms.clause.length > 200) {
    problems.push('the agreement clause that sets the amount and due date is required (up to 200 characters)');
  }
  if (!Number.isInteger(terms.amountMinor) || (terms.amountMinor as number) < 0) {
    problems.push('the agreed amount must be a whole number of minor units, zero or more, taken from the agreement');
  }
  if (!terms.currency || !ISO_CURRENCY.test(terms.currency)) {
    problems.push('the agreed currency must be an ISO 4217 code taken from the agreement');
  }
  if (!terms.dueAtUtc || !isValidInstant(terms.dueAtUtc)) {
    problems.push('the due date must come from the partner agreement, as a valid instant');
  }
  return problems;
}

// Evidence that no remittance is owed. It needs an administrator's approval and a reason tied to the agreement.
export function validateNoObligationRecord(record: Partial<NoObligationRecord>): string[] {
  const problems: string[] = [];
  if (!record.agreementReference || record.agreementReference.trim().length === 0) {
    problems.push('a not-required remittance needs the approved partner agreement reference');
  }
  if (!record.agreementClause || record.agreementClause.trim().length === 0) {
    problems.push('a not-required remittance needs the agreement clause that shows no remittance is owed');
  }
  if (record.approvedByAdministrator !== true) {
    problems.push('a not-required remittance needs an administrator to approve it');
  }
  if (!record.approvedAtUtc || !isValidInstant(record.approvedAtUtc)) {
    problems.push('a not-required remittance needs the approval time');
  }
  if (!record.evidence || record.evidence.trim().length < NO_OBLIGATION_EVIDENCE_MIN) {
    problems.push(`a not-required remittance needs written evidence of at least ${NO_OBLIGATION_EVIDENCE_MIN} characters`);
  }
  return problems;
}

// Returns the reasons a change is refused. An empty list means the change may be made.
// from is null when the remittance is being created.
export function remittanceChangeProblems(input: {
  readonly role: StaffRole;
  readonly from: RemittanceStatus | null;
  readonly to: RemittanceStatus;
  readonly reason?: string;
}): string[] {
  const problems: string[] = [];
  const { role, from, to } = input;
  if (!(REMITTANCE_STATUSES as readonly string[]).includes(to)) problems.push(`unknown remittance status ${to}`);
  if (role === 'customer') problems.push('customers cannot change a partner remittance');
  else if (role === 'support' || role === 'operations') problems.push(`${role} staff have no partner remittance access`);
  if (from === null) {
    if (!REMITTANCE_INSERT_STATUSES.includes(to)) problems.push(`a remittance cannot be created as ${to}`);
  } else if (!REMITTANCE_TRANSITIONS[from].includes(to)) {
    problems.push(`illegal remittance transition ${from} -> ${to}`);
  }
  if (ADMIN_ONLY_REMITTANCE_STATUSES.includes(to) && role !== 'admin') {
    problems.push(`only an administrator can record a remittance as ${to}`);
  }
  if ((to === 'failed' || to === 'under_review') && !(input.reason && input.reason.trim())) {
    problems.push(`a remittance marked ${to} needs a reason`);
  }
  if (from !== null && (from === 'failed' || from === 'under_review') && to === 'pending' && !(input.reason && input.reason.trim())) {
    problems.push('a recovery attempt needs a note on what was corrected before it is retried');
  }
  return problems;
}

// Correcting an agreement field (amount, currency, due date, reference, clause) is an administrator action with a reason.
export function agreementCorrectionProblems(input: {
  readonly role: StaffRole;
  readonly changedFields: readonly string[];
  readonly reason?: string;
}): string[] {
  const problems: string[] = [];
  if (input.changedFields.length === 0) return problems;
  if (input.role !== 'admin') problems.push('only an administrator can correct agreement terms on a remittance');
  if (!(input.reason && input.reason.trim())) problems.push('a correction to agreement terms needs a reason');
  return problems;
}

// Limitation: one record per booking. Instalments or several invoices under one booking are not representable.
export const REMITTANCE_RECORDS_PER_BOOKING = 1 as const;
