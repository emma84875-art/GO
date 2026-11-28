#!/usr/bin/env bash
# Concurrency checks for the operation ledger (docs/26). Runs many parallel PostgreSQL sessions against one disposable
# database and checks that exactly one of them is allowed to start each operation.
# Never point this at a real or shared database: it drops and recreates LEDGER_DB.
set -euo pipefail

LEDGER_DB="${LEDGER_DB:-booking_ledger_concurrency_test}"
WORKERS="${WORKERS:-24}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PSQL=(psql -v ON_ERROR_STOP=1 -q)

if [[ "${LEDGER_DB}" != *test* ]]; then
  echo "Refusing to run: the database name must contain the word 'test' (got '${LEDGER_DB}')." >&2
  exit 1
fi

"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS ${LEDGER_DB};" -c "CREATE DATABASE ${LEDGER_DB};"
"${PSQL[@]}" -d "${LEDGER_DB}" -f "${ROOT}/supabase/tests/00_supabase_shim.sql"
for migration in "${ROOT}"/supabase/migrations/*.sql; do
  "${PSQL[@]}" -d "${LEDGER_DB}" -f "${migration}"
done

FINGERPRINT="$(printf 'concurrency-request' | sha256sum | cut -d' ' -f1)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

# Phase 1: many workers begin the same external operation at the same moment. Exactly one may start.
for i in $(seq 1 "${WORKERS}"); do
  psql -At -d "${LEDGER_DB}" -v ON_ERROR_STOP=1 -c \
    "select public.begin_operation('supplier.order', 'concurrency-order', null, 'booking-concurrency', '${FINGERPRINT}', 'backend:concurrency', 'corr-${i}', 'worker-${i}', 300)->>'decision';" \
    > "${WORK_DIR}/begin-${i}.out" 2>&1 &
done
wait

# Counts files whose only line matches. A zero count is a result, not an error.
count_lines() {
  local pattern="$1"; shift
  local n
  n="$(grep -l -x -- "${pattern}" "$@" 2>/dev/null | wc -l)" || true
  echo "${n//[[:space:]]/}"
}

started="$(count_lines 'started' "${WORK_DIR}"/begin-*.out)"
busy="$(count_lines 'in_progress' "${WORK_DIR}"/begin-*.out)"
if [[ "${started}" != "1" || "$((started + busy))" != "${WORKERS}" ]]; then
  echo "Concurrency check failed: expected 1 start and $((WORKERS - 1)) in_progress, got ${started} started and ${busy} in_progress." >&2
  cat "${WORK_DIR}"/begin-*.out >&2
  exit 1
fi
rows="$(psql -At -d "${LEDGER_DB}" -c "select count(*) from public.operation_ledger where idempotency_key = 'concurrency-order';")"
attempts="$(psql -At -d "${LEDGER_DB}" -c "select attempt_count from public.operation_ledger where idempotency_key = 'concurrency-order';")"
if [[ "${rows}" != "1" || "${attempts}" != "1" ]]; then
  echo "Concurrency check failed: expected one row at attempt 1, found ${rows} rows at attempt ${attempts}." >&2
  exit 1
fi
echo "PASS concurrent begins: ${WORKERS} sessions, one start, one row"

# Phase 2: many workers try to record a result. Only the holder's completion is accepted.
HOLDER="$(psql -At -d "${LEDGER_DB}" -c "select lease_owner from public.operation_ledger where idempotency_key = 'concurrency-order';")"
if [[ -z "${HOLDER}" ]]; then
  echo "Concurrency check failed: no lease holder after the begins." >&2
  exit 1
fi
for i in $(seq 1 "${WORKERS}"); do
  owner="intruder-${i}"
  if [[ "${i}" == "1" ]]; then owner="${HOLDER}"; fi
  psql -At -d "${LEDGER_DB}" -v ON_ERROR_STOP=1 -c \
    "select public.complete_operation((select id from public.operation_ledger where idempotency_key = 'concurrency-order'), '${owner}', 'succeeded', 'SO-CONCURRENT', null, 'corr-complete-${i}');" \
    > "${WORK_DIR}/complete-${i}.out" 2>&1 &
done
wait

completed="$(count_lines 'completed' "${WORK_DIR}"/complete-*.out)"
stale="$(count_lines 'rejected_stale' "${WORK_DIR}"/complete-*.out)"
if [[ "${completed}" != "1" || "$((completed + stale))" != "${WORKERS}" ]]; then
  echo "Concurrency check failed: expected 1 completion, got ${completed} completed and ${stale} rejected." >&2
  cat "${WORK_DIR}"/complete-*.out >&2
  exit 1
fi
status="$(psql -At -d "${LEDGER_DB}" -c "select status || ':' || result_ref from public.operation_ledger where idempotency_key = 'concurrency-order';")"
if [[ "${status}" != "succeeded:SO-CONCURRENT" ]]; then
  echo "Concurrency check failed: unexpected final state ${status}." >&2
  exit 1
fi
echo "PASS concurrent completions: one holder recorded the result, $((WORKERS - 1)) stale completions rejected"

# Phase 3: a repeated begin after success returns the result to every worker, and starts nothing.
repeats="$(for i in $(seq 1 "${WORKERS}"); do
  psql -At -d "${LEDGER_DB}" -c "select public.begin_operation('supplier.order', 'concurrency-order', null, 'booking-concurrency', '${FINGERPRINT}', 'backend:concurrency', 'corr-r-${i}', 'retry-${i}', 300)->>'decision';" &
done; wait)"
repeated="$(echo "${repeats}" | grep -c -x 'already_succeeded' || true)"
if [[ "${repeated}" != "${WORKERS}" ]]; then
  echo "Concurrency check failed: a repeat after success did not return the recorded result for every worker." >&2
  exit 1
fi
echo "PASS repeats after success: all ${WORKERS} return the recorded result"
echo "Ledger concurrency checks passed."
