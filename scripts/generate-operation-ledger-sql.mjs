// Renders supabase/migrations/20261127000000_operation_ledger.sql from its template and the TypeScript ledger model,
// so the operation types, statuses, transition table, lease bounds and attempt events cannot drift from the code.
//
//   node scripts/generate-operation-ledger-sql.mjs          write the migration
//   node scripts/generate-operation-ledger-sql.mjs --check  exit 1 if the committed migration is stale
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ATTEMPT_EVENTS,
  EXTERNAL_OPERATION_TYPES,
  LEASE_SECONDS_MAX,
  LEASE_SECONDS_MIN,
  LIVE_STATUSES,
  OPERATION_STATUSES,
  OPERATION_TRANSITIONS,
  OPERATION_TYPES,
  subjectIsUnique,
} from '../packages/operations/src/ledger.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const templatePath = `${root}/scripts/sql-templates/operation-ledger.sql.tpl`;
export const migrationPath = `${root}/supabase/migrations/20261127000000_operation_ledger.sql`;

const list = (values) => values.map((v) => `'${v}'`).join(', ');

export function render() {
  const template = readFileSync(templatePath, 'utf8');
  const transitions = Object.entries(OPERATION_TRANSITIONS)
    .flatMap(([from, targets]) => targets.map((to) => `      ('${from}', '${to}')`))
    .join(',\n');
  return template
    .replaceAll('@@OPERATION_TYPES@@', list(OPERATION_TYPES))
    .replaceAll('@@OPERATION_STATUSES@@', list(OPERATION_STATUSES))
    .replaceAll('@@LIVE_STATUSES@@', list(LIVE_STATUSES))
    .replaceAll('@@SUBJECT_TYPES@@', list(OPERATION_TYPES.filter(subjectIsUnique)))
    .replaceAll('@@EXTERNAL_TYPES@@', list(EXTERNAL_OPERATION_TYPES))
    .replaceAll('@@ATTEMPT_EVENTS@@', list(ATTEMPT_EVENTS))
    .replaceAll('@@OPERATION_TRANSITIONS@@', transitions)
    .replaceAll('@@LEASE_MIN@@', String(LEASE_SECONDS_MIN))
    .replaceAll('@@LEASE_MAX@@', String(LEASE_SECONDS_MAX));
}

function main() {
  const output = render();
  if (process.argv.includes('--check')) {
    const committed = readFileSync(migrationPath, 'utf8');
    if (committed !== output) {
      console.error('supabase/migrations/20261127000000_operation_ledger.sql is stale. Run: node scripts/generate-operation-ledger-sql.mjs');
      process.exit(1);
    }
    console.log('operation ledger migration is up to date');
    return;
  }
  writeFileSync(migrationPath, output);
  console.log(`wrote ${migrationPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
