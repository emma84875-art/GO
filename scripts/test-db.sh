#!/usr/bin/env bash
# Runs the database checks against a disposable local PostgreSQL database.
# Requires psql and a reachable server. Set PGHOST, PGPORT and PGUSER as needed.
# Never point this at a real or shared database: it drops and recreates TEST_DB.
set -euo pipefail

TEST_DB="${TEST_DB:-booking_test}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "${TEST_DB}" != *test* ]]; then
  echo "Refusing to run: TEST_DB must contain the word 'test' (got '${TEST_DB}')." >&2
  exit 1
fi

PSQL=(psql -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS ${TEST_DB};" -c "CREATE DATABASE ${TEST_DB};"

"${PSQL[@]}" -d "${TEST_DB}" -f "${ROOT}/supabase/tests/00_supabase_shim.sql"
for migration in "${ROOT}"/supabase/migrations/*.sql; do
  echo "Applying $(basename "${migration}")"
  "${PSQL[@]}" -d "${TEST_DB}" -f "${migration}"
done

"${PSQL[@]}" -d "${TEST_DB}" -f "${ROOT}/supabase/tests/rls_policies.sql"
echo "Database checks passed."
