#!/usr/bin/env bash
# Runs the database checks against disposable local PostgreSQL databases.
# Requires psql and a reachable server. Set PGHOST, PGPORT and PGUSER as needed.
# Never point this at a real or shared database: it drops and recreates TEST_DB and ROUNDTRIP_DB.
set -euo pipefail

TEST_DB="${TEST_DB:-booking_test}"
ROUNDTRIP_DB="${ROUNDTRIP_DB:-booking_roundtrip_test}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIFECYCLE_MIGRATION="20261126000000_booking_lifecycle.sql"
ROLLBACK="${ROOT}/supabase/rollbacks/20261126000000_booking_lifecycle.down.sql"

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

# 1. Full build, then the existing RLS and constraint checks and the Phase 19.1 lifecycle checks.
build_database "${TEST_DB}"
"${PSQL[@]}" -d "${TEST_DB}" -f "${ROOT}/supabase/tests/rls_policies.sql"
"${PSQL[@]}" -d "${TEST_DB}" -f "${ROOT}/supabase/tests/booking_lifecycle.sql"

# 2. Rollback round trip on an empty database: roll back 19.1, check the legacy model is back, re-apply 19.1, re-run the lifecycle checks.
build_database "${ROUNDTRIP_DB}"
"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${ROLLBACK}"
legacy_columns="$("${PSQL[@]}" -d "${ROUNDTRIP_DB}" -At -c "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'bookings' and column_name in ('reservation_status', 'ticket_status');")"
if [[ "${legacy_columns}" != "2" ]]; then
  echo "Rollback check failed: expected 2 legacy booking columns, found ${legacy_columns}." >&2
  exit 1
fi
"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${ROOT}/supabase/migrations/${LIFECYCLE_MIGRATION}"
"${PSQL[@]}" -d "${ROUNDTRIP_DB}" -f "${ROOT}/supabase/tests/booking_lifecycle.sql"

echo "Database checks passed."
