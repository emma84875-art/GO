-- Phase 19.2 database checks: the operation ledger and its idempotency, lease, fencing, reconciliation and
-- append-only rules (docs/26). Run after all migrations (scripts/test-db.sh). The file runs in one transaction and
-- rolls back, so it leaves no data behind. Any failed check stops the run with an error.
-- Lease expiry is tested with real time (pg_sleep), because the database clock is the authority.

begin;

-- Test helpers. They call the same service functions the backend calls, with no signed-in user present.
create function pg_temp.check(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'FAIL %', p_label;
  end if;
  raise notice 'PASS %', p_label;
end $$;

create function pg_temp.fp(p_seed text) returns text
language sql immutable as $$ select encode(sha256(convert_to(p_seed, 'UTF8')), 'hex') $$;

create function pg_temp.begin_op(p_type text, p_key text, p_subject text, p_seed text, p_owner text, p_lease integer)
returns jsonb
language sql as $$
  select public.begin_operation(p_type, p_key, null, p_subject, pg_temp.fp(p_seed), 'backend:test', 'corr-' || p_key, p_owner, p_lease)
$$;

create function pg_temp.op_id(p_type text, p_key text) returns uuid
language sql as $$
  select id from public.operation_ledger where operation_type = p_type and idempotency_key = p_key
$$;

create function pg_temp.row_status(p_type text, p_key text) returns text
language sql as $$
  select status from public.operation_ledger where operation_type = p_type and idempotency_key = p_key
$$;

create function pg_temp.attempt_count(p_type text, p_key text, p_event text) returns bigint
language sql as $$
  select count(*) from public.operation_attempts a
  join public.operation_ledger o on o.id = a.operation_id
  where o.operation_type = p_type and o.idempotency_key = p_key and a.event = p_event
$$;

-- A. One key, one operation.
do $$
declare r jsonb; again jsonb; v_id uuid;
begin
  r := pg_temp.begin_op('supplier.order', 'k-a1', 'sub-a1', 'fpA', 'w1', 60);
  perform pg_temp.check(r->>'decision' = 'started' and (r->>'attempt_no')::int = 1 and (r->>'takeover')::boolean = false, 'A1 a new key starts one operation at attempt 1');
  v_id := pg_temp.op_id('supplier.order', 'k-a1');
  again := pg_temp.begin_op('supplier.order', 'k-a1', 'sub-a1', 'fpA', 'w2', 60);
  perform pg_temp.check(again->>'decision' = 'in_progress' and (again->>'operation_id')::uuid = v_id, 'A2 a duplicate while in progress creates nothing new');
  perform pg_temp.check((select count(*) from public.operation_ledger where idempotency_key = 'k-a1') = 1, 'A3 exactly one ledger row for the key');
  perform pg_temp.check((select attempt_count from public.operation_ledger where id = v_id) = 1, 'A4 attempt count is still 1 after a duplicate');
  perform pg_temp.check(pg_temp.attempt_count('supplier.order', 'k-a1', 'started') = 1, 'A5 the attempt log records one start');
end $$;

-- B. Key reuse with a different request is refused and changes nothing.
do $$
declare r jsonb;
begin
  r := pg_temp.begin_op('supplier.order', 'k-a1', 'sub-a1', 'a different request', 'w3', 60);
  perform pg_temp.check(r->>'decision' = 'key_reused', 'B1 the same key with a different request is refused');
  perform pg_temp.check(pg_temp.row_status('supplier.order', 'k-a1') = 'in_progress', 'B2 key reuse changes no status');
end $$;

-- C. For a subject-unique type, a live operation for the same subject holds it.
do $$
declare r jsonb;
begin
  r := pg_temp.begin_op('supplier.order', 'k-c1', 'sub-a1', 'fpC', 'w1', 60);
  perform pg_temp.check(r->>'decision' = 'subject_busy', 'C1 a second key for a subject with a live operation is refused');
  perform pg_temp.check(pg_temp.op_id('supplier.order', 'k-c1') is null, 'C2 nothing is recorded for the refused key');
end $$;

-- D. booking.create is keyed only by its key, so two keys for the same subject both start.
do $$
declare r1 jsonb; r2 jsonb;
begin
  r1 := pg_temp.begin_op('booking.create', 'cart-d1', 'cart-d', 'fpD1', 'w1', 60);
  r2 := pg_temp.begin_op('booking.create', 'cart-d2', 'cart-d', 'fpD2', 'w1', 60);
  perform pg_temp.check(r1->>'decision' = 'started' and r2->>'decision' = 'started', 'D1 booking.create is not held by its subject');
end $$;

-- E. A success is recorded; a repeat returns the result and starts nothing.
do $$
declare r jsonb; outcome text;
begin
  outcome := public.complete_operation(pg_temp.op_id('supplier.order', 'k-a1'), 'w1', 'succeeded', 'SO-100', null, 'corr-k-a1');
  perform pg_temp.check(outcome = 'completed', 'E1 the holder records success');
  r := pg_temp.begin_op('supplier.order', 'k-a1', 'sub-a1', 'fpA', 'w9', 60);
  perform pg_temp.check(r->>'decision' = 'already_succeeded' and r->>'result_ref' = 'SO-100', 'E2 a repeat after success returns the recorded result');
  perform pg_temp.check(pg_temp.row_status('supplier.order', 'k-a1') = 'succeeded', 'E3 the row stays succeeded');
end $$;

-- F. A retryable failure may be retried under the same key; a terminal failure is never run again.
do $$
declare r jsonb; outcome text;
begin
  r := pg_temp.begin_op('supplier.order', 'k-f1', 'sub-f1', 'fpF', 'w1', 60);
  outcome := public.complete_operation(pg_temp.op_id('supplier.order', 'k-f1'), 'w1', 'failed_retryable', null, 'supplier_unavailable', 'corr');
  perform pg_temp.check(outcome = 'completed' and pg_temp.row_status('supplier.order', 'k-f1') = 'failed_retryable', 'F1 a retryable failure is recorded');
  r := pg_temp.begin_op('supplier.order', 'k-f1', 'sub-f1', 'fpF', 'w2', 60);
  perform pg_temp.check(r->>'decision' = 'started' and (r->>'attempt_no')::int = 2, 'F2 the retry starts attempt 2 under the same key');
  outcome := public.complete_operation(pg_temp.op_id('supplier.order', 'k-f1'), 'w2', 'failed_terminal', null, 'fare_changed', 'corr');
  r := pg_temp.begin_op('supplier.order', 'k-f1', 'sub-f1', 'fpF', 'w3', 60);
  perform pg_temp.check(r->>'decision' = 'terminal_failure' and r->>'failure_code' = 'fare_changed', 'F3 a terminal failure is never run again');
end $$;

-- G. An interrupted external operation (lease expired) becomes unknown, is never retried, and blocks its subject.
do $$
declare r jsonb; outcome text;
begin
  r := pg_temp.begin_op('supplier.order', 'k-g1', 'sub-g1', 'fpG', 'w1', 1);
  perform pg_sleep(1.2);
  r := pg_temp.begin_op('supplier.order', 'k-g1', 'sub-g1', 'fpG', 'w2', 60);
  perform pg_temp.check(r->>'decision' = 'needs_reconciliation' and pg_temp.row_status('supplier.order', 'k-g1') = 'unknown', 'G1 an expired external lease becomes unknown, not a takeover');
  r := pg_temp.begin_op('supplier.order', 'k-g1', 'sub-g1', 'fpG', 'w3', 60);
  perform pg_temp.check(r->>'decision' = 'needs_reconciliation' and pg_temp.attempt_count('supplier.order', 'k-g1', 'lease_expired_unknown') = 1, 'G2 an unknown operation is never retried, and the expiry is logged');
  outcome := public.complete_operation(pg_temp.op_id('supplier.order', 'k-g1'), 'w1', 'succeeded', 'SO-late', null, 'late');
  perform pg_temp.check(outcome = 'rejected_stale' and pg_temp.row_status('supplier.order', 'k-g1') = 'unknown', 'G3 the original holder cannot record a result after its lease expired');
  r := pg_temp.begin_op('supplier.order', 'k-g2', 'sub-g1', 'fpG2', 'w4', 60);
  perform pg_temp.check(r->>'decision' = 'subject_busy', 'G4 an unknown operation keeps holding its subject');
end $$;

-- H. booking.create is internal: after expiry it is taken over, and the old holder is fenced out.
do $$
declare r jsonb; outcome text;
begin
  r := pg_temp.begin_op('booking.create', 'cart-h1', 'cart-h', 'fpH', 'w1', 1);
  perform pg_sleep(1.2);
  r := pg_temp.begin_op('booking.create', 'cart-h1', 'cart-h', 'fpH', 'w2', 60);
  perform pg_temp.check(r->>'decision' = 'started' and (r->>'takeover')::boolean and (r->>'attempt_no')::int = 2, 'H1 an expired booking.create is taken over at attempt 2');
  outcome := public.complete_operation(pg_temp.op_id('booking.create', 'cart-h1'), 'w1', 'succeeded', 'B-1', null, 'old');
  perform pg_temp.check(outcome = 'rejected_stale', 'H2 the previous holder is fenced out');
  outcome := public.complete_operation(pg_temp.op_id('booking.create', 'cart-h1'), 'w2', 'succeeded', 'B-1', null, 'new');
  perform pg_temp.check(outcome = 'completed' and pg_temp.row_status('booking.create', 'cart-h1') = 'succeeded', 'H3 the new holder records the result');
end $$;

-- I. Fencing: only the lease holder may record a result, and the attempt is logged.
do $$
declare outcome text;
begin
  perform pg_temp.begin_op('payment.capture_request', 'capture-i1', 'intent-i1', 'fpI', 'w1', 300);
  outcome := public.complete_operation(pg_temp.op_id('payment.capture_request', 'capture-i1'), 'intruder', 'succeeded', 'CP-1', null, 'x');
  perform pg_temp.check(outcome = 'rejected_stale' and pg_temp.row_status('payment.capture_request', 'capture-i1') = 'in_progress', 'I1 a non-holder cannot record a result');
  perform pg_temp.check(pg_temp.attempt_count('payment.capture_request', 'capture-i1', 'stale_completion_rejected') = 1, 'I2 the rejected completion is logged');
end $$;

-- J. Reconciliation resolves an unknown operation only with evidence and from a reconciliation actor.
do $$
declare outcome text; r jsonb; v_id uuid;
begin
  r := pg_temp.begin_op('supplier.order', 'k-j1', 'sub-j1', 'fpJ', 'w1', 1);
  perform pg_sleep(1.2);
  r := pg_temp.begin_op('supplier.order', 'k-j1', 'sub-j1', 'fpJ', 'w2', 60);
  v_id := pg_temp.op_id('supplier.order', 'k-j1');
  outcome := public.reconcile_operation(v_id, 'succeeded', 'SO-200', null, 'lookup-1', 'backend:worker', 'rc');
  perform pg_temp.check(outcome = 'refused', 'J1 a non-reconciliation actor cannot reconcile');
  outcome := public.reconcile_operation(v_id, 'succeeded', 'SO-200', null, '', 'reconciliation:lookup-1', 'rc');
  perform pg_temp.check(outcome = 'refused', 'J2 reconciliation without evidence is refused');
  outcome := public.reconcile_operation(v_id, 'succeeded', 'SO-200', null, 'supplier-lookup-1', 'reconciliation:lookup-1', 'rc');
  perform pg_temp.check(outcome = 'reconciled' and pg_temp.row_status('supplier.order', 'k-j1') = 'succeeded', 'J3 evidence from a reconciliation actor resolves the unknown operation');
  r := pg_temp.begin_op('supplier.order', 'k-j1', 'sub-j1', 'fpJ', 'w3', 60);
  perform pg_temp.check(r->>'decision' = 'already_succeeded' and r->>'result_ref' = 'SO-200', 'J4 after reconciliation, a repeat returns the result');
  outcome := public.reconcile_operation(v_id, 'failed_terminal', null, 'x', 'lookup-2', 'reconciliation:lookup-2', 'rc');
  perform pg_temp.check(outcome = 'refused', 'J5 a succeeded operation cannot be reconciled again');
  -- Not created: a single retry is allowed after reconciliation confirms nothing exists.
  r := pg_temp.begin_op('supplier.order', 'k-j2', 'sub-j2', 'fpJ2', 'w1', 1);
  perform pg_sleep(1.2);
  r := pg_temp.begin_op('supplier.order', 'k-j2', 'sub-j2', 'fpJ2', 'w2', 60);
  outcome := public.reconcile_operation(pg_temp.op_id('supplier.order', 'k-j2'), 'failed_retryable', null, 'not_created', 'lookup-3', 'reconciliation:lookup-3', 'rc');
  r := pg_temp.begin_op('supplier.order', 'k-j2', 'sub-j2', 'fpJ2', 'w4', 60);
  perform pg_temp.check(outcome = 'reconciled' and r->>'decision' = 'started' and (r->>'attempt_no')::int = 2, 'J6 reconciliation that confirms nothing was created allows one retry');
end $$;

-- K. Renewal: the holder extends its lease; a non-holder cannot.
do $$
declare ok boolean; r jsonb;
begin
  perform pg_temp.begin_op('supplier.cancel', 'cancel-k1', 'sub-k1', 'fpK', 'w1', 1);
  ok := public.renew_operation_lease(pg_temp.op_id('supplier.cancel', 'cancel-k1'), 'w1', 300);
  perform pg_temp.check(ok, 'K1 the holder renews its lease');
  perform pg_temp.check(not public.renew_operation_lease(pg_temp.op_id('supplier.cancel', 'cancel-k1'), 'w2', 300), 'K2 a non-holder cannot renew');
  perform pg_sleep(1.2);
  r := pg_temp.begin_op('supplier.cancel', 'cancel-k1', 'sub-k1', 'fpK', 'w2', 60);
  perform pg_temp.check(r->>'decision' = 'in_progress', 'K3 a renewed lease keeps the operation in progress for other workers');
end $$;

-- L. Validation: lease bounds, required results and codes, known types.
do $$
declare r jsonb; raised boolean;
begin
  r := pg_temp.begin_op('supplier.order', 'k-l1', 'sub-l1', 'fpL', 'w1', 0);
  perform pg_temp.check(r->>'decision' = 'refused', 'L1 a zero lease is refused');
  r := pg_temp.begin_op('supplier.order', 'k-l1', 'sub-l1', 'fpL', 'w1', 4000);
  perform pg_temp.check(r->>'decision' = 'refused', 'L2 a lease above the maximum is refused');
  perform pg_temp.begin_op('supplier.order', 'k-l1', 'sub-l1', 'fpL', 'w1', 300);
  raised := false;
  begin
    perform public.complete_operation(pg_temp.op_id('supplier.order', 'k-l1'), 'w1', 'succeeded', '  ', null, 'x');
  exception when check_violation then raised := true; end;
  perform pg_temp.check(raised, 'L3 a success needs a result reference');
  raised := false;
  begin
    perform public.complete_operation(pg_temp.op_id('supplier.order', 'k-l1'), 'w1', 'failed_retryable', null, '', 'x');
  exception when check_violation then raised := true; end;
  perform pg_temp.check(raised, 'L4 a failure needs a code');
  raised := false;
  begin
    perform pg_temp.begin_op('refund.bogus', 'k-l2', 'sub-l2', 'fpL2', 'w1', 60);
  exception when check_violation then raised := true; end;
  perform pg_temp.check(raised, 'L5 an unknown operation type is refused');
end $$;

-- M. Append-only history and the guard on status changes.
do $$
declare raised boolean; v_id uuid;
begin
  v_id := pg_temp.op_id('supplier.order', 'k-a1');
  raised := false;
  begin update public.operation_attempts set event = 'started' where operation_id = v_id;
  exception when insufficient_privilege then raised := true; end;
  perform pg_temp.check(raised, 'M1 attempts cannot be updated');
  raised := false;
  begin delete from public.operation_attempts where operation_id = v_id;
  exception when insufficient_privilege then raised := true; end;
  perform pg_temp.check(raised, 'M2 attempts cannot be deleted');
  raised := false;
  begin delete from public.operation_ledger where id = v_id;
  exception when insufficient_privilege then raised := true; end;
  perform pg_temp.check(raised, 'M3 ledger rows cannot be deleted');
  raised := false;
  begin update public.operation_ledger set status = 'succeeded', result_ref = 'forged' where id = pg_temp.op_id('supplier.order', 'k-g1');
  exception when insufficient_privilege then raised := true; end;
  perform pg_temp.check(raised, 'M4 a status cannot be changed outside the ledger functions');
  raised := false;
  begin perform set_config('go.operation_authority', 'ledger_function', true);
    update public.operation_ledger set status = 'in_progress' where id = pg_temp.op_id('supplier.order', 'k-g1');
  exception when check_violation then raised := true; end;
  perform set_config('go.operation_authority', '', true);
  perform pg_temp.check(raised, 'M5 a status change outside the transition table is refused even inside the ledger');
end $$;

-- N. Roles: only the service role may run the operation functions. Signed-in users and anonymous callers are refused.
do $$
declare raised boolean := false;
begin
  set local role authenticated;
  begin
    perform public.begin_operation('supplier.order', 'k-n1', null, 'sub-n1', pg_temp.fp('fpN'), 'backend:test', 'c', 'w1', 60);
  exception when insufficient_privilege then raised := true; end;
  reset role;
  perform pg_temp.check(raised, 'N1 a signed-in user cannot begin an operation');
end $$;

do $$
declare raised boolean := false;
begin
  set local role anon;
  begin
    perform public.complete_operation(pg_temp.op_id('supplier.order', 'k-a1'), 'w1', 'failed_retryable', null, 'x', 'c');
  exception when insufficient_privilege then raised := true; end;
  reset role;
  perform pg_temp.check(raised, 'N2 an anonymous caller cannot complete an operation');
end $$;

do $$
declare r jsonb;
begin
  set local role service_role;
  r := public.begin_operation('supplier.order', 'k-n2', null, 'sub-n2', pg_temp.fp('fpN2'), 'backend:test', 'c', 'w1', 60);
  reset role;
  perform pg_temp.check(r->>'decision' = 'started', 'N3 the service role can begin an operation');
end $$;

-- O. Attempt counts agree with the attempt log: one per start and one per takeover.
do $$
begin
  perform pg_temp.check(
    not exists (
      select 1 from public.operation_ledger o
      where o.attempt_count <> (select count(*) from public.operation_attempts a
                                where a.operation_id = o.id and a.event in ('started', 'lease_taken_over'))
    ),
    'O1 attempt counts agree with the attempt log');
end $$;

rollback;
