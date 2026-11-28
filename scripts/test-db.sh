#!/usr/bin/env bash
# Runs the database checks against disposable local PostgreSQL databases.
# Requires psql and a reachable server. Set PGHOST, PGPORT and PGUSER as needed.
# Never point this at a real or shared database: it drops and recreates TEST_DB and ROUNDTRIP_DB.
set -euo pipefail

TEST_DB="${TEST_DB:-booking_test}"
ROUNDTRIP_DB="${ROUNDTRIP_DB:-booking_roundtrip_test}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIFECYCLE_MIGRATION="20261126000000_booking_lifecycle.sql"
LIFECYCLE_ROLLBACK="${ROOT}/supabase/rollbacks/20261126000000_booking_lifecycle.down.sql"
LEDGER_MIGRATION="20261127000000_operation_ledger.sql"
LEDGER_ROLLBACK="${ROOT}/supabase/rollbacks/20261127000000_operation_ledger.down.sql"
AUTHORITY_MIGRATION="20261129000000_payment_authority.sql"
AUTHORITY_ROLLBACK="${ROOT}/supabase/rollbacks/20261129000000_payment_authority.down.sql"
GUARDS_MIGRATION="20261130000000_payment_guards.sql"
GUARDS_ROLLBACK="${ROOT}/supabase/rollbacks/20261130000000_payment_guards.down.sql"

for name in "${TEST_DB}" "${ROUNDTRIP_DB}"; do
  if [[ "${name}" != *test* ]]; then
    echo "Refusing to run: database names must contain the word 'test' (got '${name}')." >&2
    exit 1
  fi
done

PSQL=(psql -v ON_ERROR_STOP=1 -q)

# Creates a fresh database with the shim and every migration applied, in filename order.
build_database() {
  local name="$1"
  "${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS ${name};" -c "CREATE DATABASE ${name};"
  "${PSQL[@]}" -d "${name}" -f "${ROOT}/supabase/tests/00_supabase_shim.sql"
  for migration in "${ROOT}"/supabase/migrations/*.sql; do
    echo "Applying $(basename "${migration}") to ${name}"
    "${PSQL[@]}" -d "${name}" -f "${migration}"
  done
}

# 1. Generated migrations match their sources, then the full build, the RLS and constraint checks, the Phase 19.1
#    lifecycle checks and the Phase 19.2 operation ledger checks.
node --disable-warning=ExperimentalWarning "${ROOT}/scripts/generate-booking-lifecycle-sql.mjs" --check
node --disable-warning=ExperimentalWarning "${ROOT}/scripts/generate-operation-ledger-sql.mjs" --check
build_database "${TEST_DB}"
"${PSQL[@]}" -d "${TEST_DB}" -f "${ROOT}/supabase/tests/rls_policies.sql"
"${PSQL[@]}" -d "${TEST_DB}" -f "${ROOT}/supabase/tests/booking_lifecycle.sql"
"${PSQL[@]}" -d "${TEST_DB}" -f "${ROOT}/supabase/tests/operation_ledger.sql"
"${PSQL[@]}" -d "${TEST_DB}" -f "${ROOT}/supabase/tests/payment_authority.sql"
"${PSQL[@]}" -d "${TEST_DB}" -f "${ROOT}/supabase/tests/payment_guards.sql"

# 2. Rollback round trip on a fresh database. Roll back 19.2 (refused if the ledger holds data), check its objects are
#    gone, re-apply it and re-run its checks. Then roll back 19.1, check the legacy model is back, re-apply both and
#    re-run the checks.
build_database "${ROUNDTRIP_DB}"
"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${GUARDS_ROLLBACK}"
guard_objects="$("${PSQL[@]}" -d "${ROUNDTRIP_DB}" -At -c "select count(*) from pg_trigger where tgname in ('payments_immutable_guard', 'bookings_price_guard') and not tgisinternal;")"
if [[ "${guard_objects}" != "0" ]]; then
  echo "Rollback check failed: expected the payment and booking guards to be gone, found ${guard_objects}." >&2
  exit 1
fi
"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${AUTHORITY_ROLLBACK}"
authority_functions="$("${PSQL[@]}" -d "${ROUNDTRIP_DB}" -At -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'app_payment_%';")"
if [[ "${authority_functions}" != "0" ]]; then
  echo "Rollback check failed: expected the payment authority functions to be gone, found ${authority_functions}." >&2
  exit 1
fi
"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${ROOT}/supabase/migrations/${AUTHORITY_MIGRATION}"
"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${ROOT}/supabase/migrations/${GUARDS_MIGRATION}"
"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${ROOT}/supabase/tests/payment_authority.sql"
"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${ROOT}/supabase/tests/payment_guards.sql"

"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${LEDGER_ROLLBACK}"
ledger_tables="$("${PSQL[@]}" -d "${ROUNDTRIP_DB}" -At -c "select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('operation_ledger', 'operation_attempts');")"
if [[ "${ledger_tables}" != "0" ]]; then
  echo "Rollback check failed: expected the ledger tables to be gone, found ${ledger_tables}." >&2
  exit 1
fi
"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${ROOT}/supabase/migrations/${LEDGER_MIGRATION}"
"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${ROOT}/supabase/tests/operation_ledger.sql"

"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${LEDGER_ROLLBACK}"
"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${LIFECYCLE_ROLLBACK}"
legacy_columns="$("${PSQL[@]}" -d "${ROUNDTRIP_DB}" -At -c "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'bookings' and column_name in ('reservation_status', 'ticket_status');")"
if [[ "${legacy_columns}" != "2" ]]; then
  echo "Rollback check failed: expected 2 legacy booking columns, found ${legacy_columns}." >&2
  exit 1
fi
"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${ROOT}/supabase/migrations/${LIFECYCLE_MIGRATION}"
"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${ROOT}/supabase/tests/booking_lifecycle.sql"
"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${ROOT}/supabase/tests/payment_guards.sql"
"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${ROOT}/supabase/migrations/${LEDGER_MIGRATION}"
"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${ROOT}/supabase/tests/operation_ledger.sql"

# 3. Concurrency: parallel sessions against their own disposable database.
LEDGER_DB="${LEDGER_DB:-booking_ledger_concurrency_test}" bash "${ROOT}/scripts/test-ledger-concurrency.sh"

# 4. Application checks: the TypeScript execution paths against the disposable test database. Restart checks run
#    the order worker in separate processes, so no in-memory state survives between runs.
LEDGER_INTEGRATION=1 PGDATABASE="${TEST_DB}" node --disable-warning=ExperimentalWarning --test "${ROOT}/packages/operations/test/postgres-ledger.integration.test.ts"
LEDGER_INTEGRATION=1 PGDATABASE="${TEST_DB}" node --disable-warning=ExperimentalWarning --test "${ROOT}/packages/app/test/app.integration.test.ts"

echo "Database checks passed."
