// Renders supabase/migrations/20261126000000_booking_lifecycle.sql from its template and the TypeScript
// sources, so the database transition table, stage table and currency reference cannot drift from the code.
//
//   node scripts/generate-booking-lifecycle-sql.mjs          write the migration
//   node scripts/generate-booking-lifecycle-sql.mjs --check  exit 1 if the committed migration is stale
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BOOKING_STATES,
  BOOKING_TRANSITIONS,
  STAGE_OF,
  TICKETS_VISIBLE_STATES,
  REMITTANCE_STATUSES,
  REMITTANCE_TRANSITIONS,
} from '../packages/core/src/booking-lifecycle.ts';
import { ADMIN_ONLY_REMITTANCE_STATUSES, REMITTANCE_INSERT_STATUSES } from '../packages/core/src/partner-remittance.ts';
import { CURRENCY_ENTRIES } from '../packages/core/src/currency-metadata.ts';
import { PAYMENT_STATUSES, PAYMENT_TRANSITIONS } from '../packages/payments/src/state.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const templatePath = `${root}/scripts/sql-templates/booking-lifecycle.sql.tpl`;
export const migrationPath = `${root}/supabase/migrations/20261126000000_booking_lifecycle.sql`;

const sql = (text) => text.replace(/'/g, "''");

export function render() {
  const template = readFileSync(templatePath, 'utf8');

  const states = BOOKING_STATES.map((state) => `    '${state}'`).join(',\n');

  const stages = BOOKING_STATES.map((state) => `    when '${state}' then ${STAGE_OF[state]}`).join('\n');

  const transitions = Object.entries(BOOKING_TRANSITIONS)
    .flatMap(([from, targets]) => targets.map((to) => `    ('${from}', '${to}')`))
    .join(',\n');

  const currencies = CURRENCY_ENTRIES.filter((entry) => entry.classification === 'currency')
    .map((e) => `  ('${e.code}', ${e.exponent}, '${e.listStatus}', '${sql(e.name)}')`)
    .join(',\n');

  const visible = TICKETS_VISIBLE_STATES.map((state) => `'${state}'`).join(', ');

  const remittanceStatuses = REMITTANCE_STATUSES.map((status) => `'${status}'`).join(', ');

  const remittanceTransitions = Object.entries(REMITTANCE_TRANSITIONS)
    .flatMap(([from, targets]) => targets.map((to) => `    ('${from}', '${to}')`))
    .join(',\n');

  const adminOnly = ADMIN_ONLY_REMITTANCE_STATUSES.map((status) => `'${status}'`).join(', ');
  const insertable = REMITTANCE_INSERT_STATUSES.map((status) => `'${status}'`).join(', ');

  const paymentStatuses = PAYMENT_STATUSES.map((status) => `'${status}'`).join(', ');
  const paymentTransitions = Object.entries(PAYMENT_TRANSITIONS)
    .flatMap(([from, targets]) => targets.map((to) => `    ('${from}', '${to}')`))
    .join(',\n');

  return template
    .replaceAll('@@PAYMENT_STATUSES@@', paymentStatuses)
    .replaceAll('@@PAYMENT_TRANSITIONS@@', paymentTransitions)
    .replaceAll('@@ADMIN_ONLY_REMITTANCE_STATUSES@@', adminOnly)
    .replaceAll('@@REMITTANCE_INSERT_STATUSES@@', insertable)
    .replaceAll('@@VISIBLE_STATES@@', visible)
    .replaceAll('@@REMITTANCE_STATUSES@@', remittanceStatuses)
    .replaceAll('@@REMITTANCE_TRANSITIONS@@', remittanceTransitions)
    .replaceAll('@@STATES@@', states)
    .replaceAll('@@STAGES@@', stages)
    .replaceAll('@@TRANSITIONS@@', transitions)
    .replaceAll('@@CURRENCIES@@', currencies);
}

function main() {
  const output = render();
  if (process.argv.includes('--check')) {
    const committed = readFileSync(migrationPath, 'utf8');
    if (committed !== output) {
      console.error('supabase/migrations/20261126000000_booking_lifecycle.sql is stale. Run: node scripts/generate-booking-lifecycle-sql.mjs');
      process.exit(1);
    }
    console.log('booking lifecycle migration is up to date');
    return;
  }
  writeFileSync(migrationPath, output);
  console.log(`wrote ${migrationPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
