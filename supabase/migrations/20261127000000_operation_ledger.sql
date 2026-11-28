-- Phase 19.2: persistent operation ledger and idempotency. Decision record: docs/26.
--
-- GENERATED FROM scripts/sql-templates/operation-ledger.sql.tpl by scripts/generate-operation-ledger-sql.mjs.
-- Do not edit the generated migration by hand. Change the template or packages/operations/src/ledger.ts and regenerate.
--
-- Safety properties:
--   1. One row per external effect or internal write, keyed by (operation_type, idempotency_key). A second request with
--      the same key returns the recorded result; it never creates a second operation.
--   2. One live operation per subject for each subject-unique type (every type except booking.create), enforced by a
--      partial unique index. A live row is in_progress, succeeded or unknown.
--   3. Only the service role can begin, complete, renew or reconcile an operation, and only through the functions below.
--      Signed-in users have read access for administrators with MFA, and no write path.
--   4. Leases are fenced: only the current lease holder can record a result. A stale holder is recorded and rejected.
--   5. An external operation whose lease expired is unknown. It is never retried automatically. Only a reconciliation
--      with evidence resolves it. booking.create is internal to one transaction and may be taken over after expiry.
--   6. Attempts are append-only. Ledger rows are never deleted, and status changes follow the transition table.
--   7. Time for leases comes from the database clock, not from the caller.

begin;

-- 1. The operation ledger. One row per operation, updated only by the functions below.
create table public.operation_ledger (
  id                  uuid primary key default gen_random_uuid(),
  operation_type      text not null check (operation_type in ('booking.create', 'supplier.order', 'supplier.cancel', 'payment.start', 'payment.capture_request', 'payment.release', 'payment.refund')),
  idempotency_key     text not null check (length(btrim(idempotency_key)) between 1 and 200),
  subject_booking_id  uuid references public.bookings (id) on delete restrict,
  subject_ref         text not null check (length(subject_ref) between 1 and 200),
  status              text not null default 'in_progress' check (status in ('in_progress', 'succeeded', 'failed_retryable', 'failed_terminal', 'unknown')),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  attempt_count       integer not null default 1 check (attempt_count >= 1),
  lease_owner         text check (length(lease_owner) between 1 and 200),
  lease_expires_at    timestamptz,
  result_ref          text check (length(result_ref) between 1 and 200),
  failure_code        text check (length(failure_code) between 1 and 100),
  actor_kind          text not null check (actor_kind in ('backend_workflow', 'provider_event', 'reconciliation')),
  actor_label         text not null check (length(actor_label) between 1 and 200),
  correlation_id      text not null check (length(correlation_id) between 1 and 200),
  created_at          timestamptz not null default clock_timestamp(),
  updated_at          timestamptz not null default clock_timestamp(),
  completed_at        timestamptz,
  constraint operation_ledger_key_unique unique (operation_type, idempotency_key),
  constraint operation_ledger_succeeded_has_result check (status <> 'succeeded' or result_ref is not null),
  constraint operation_ledger_failure_has_code check (status not in ('failed_retryable', 'failed_terminal', 'unknown') or failure_code is not null),
  constraint operation_ledger_live_has_lease check (status <> 'in_progress' or (lease_owner is not null and lease_expires_at is not null))
);

-- One live operation per subject, for every type except booking.create. A live row holds the subject.
create unique index operation_ledger_one_live_subject on public.operation_ledger (operation_type, subject_ref)
  where status in ('in_progress', 'succeeded', 'unknown') and operation_type in ('supplier.order', 'supplier.cancel', 'payment.start', 'payment.capture_request', 'payment.release', 'payment.refund');
create index operation_ledger_subject_booking_idx on public.operation_ledger (subject_booking_id);

-- 2. Attempt log. Every start, takeover, expiry, completion, rejection and reconciliation, append-only.
create table public.operation_attempts (
  id             bigint generated always as identity primary key,
  operation_id   uuid not null references public.operation_ledger (id) on delete restrict,
  attempt_no     integer not null check (attempt_no >= 1),
  event          text not null check (event in ('started', 'lease_taken_over', 'lease_expired_unknown', 'succeeded', 'failed_retryable', 'failed_terminal', 'unknown', 'stale_completion_rejected', 'reconciled_succeeded', 'reconciled_failed_retryable', 'reconciled_failed_terminal')),
  status_after   text check (status_after in ('in_progress', 'succeeded', 'failed_retryable', 'failed_terminal', 'unknown')),
  lease_owner    text check (length(lease_owner) between 1 and 200),
  failure_code   text check (length(failure_code) between 1 and 100),
  evidence_ref   text check (length(evidence_ref) between 1 and 200),
  actor_label    text not null check (length(actor_label) between 1 and 200),
  correlation_id text not null check (length(correlation_id) between 1 and 200),
  occurred_at    timestamptz not null default clock_timestamp()
);
create index operation_attempts_operation_idx on public.operation_attempts (operation_id, id);

-- 3. Transition table, from packages/operations/src/ledger.ts.
create or replace function public.operation_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from (values
      ('in_progress', 'succeeded'),
      ('in_progress', 'failed_retryable'),
      ('in_progress', 'failed_terminal'),
      ('in_progress', 'unknown'),
      ('failed_retryable', 'in_progress'),
      ('unknown', 'succeeded'),
      ('unknown', 'failed_retryable'),
      ('unknown', 'failed_terminal')
    ) as t(from_status, to_status)
    where t.from_status = p_from and t.to_status = p_to
  );
$$;

-- 4. Guards. Status changes happen only inside the functions below, which set the authority for their own transaction.
create or replace function public.guard_operation_ledger()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Operation ledger rows are never deleted' using errcode = 'insufficient_privilege';
  end if;
  if current_setting('go.operation_authority', true) is distinct from 'ledger_function' then
    raise exception 'Operation ledger changes go through the ledger functions only' using errcode = 'insufficient_privilege';
  end if;
  if new.id <> old.id or new.operation_type <> old.operation_type or new.idempotency_key <> old.idempotency_key
     or new.request_fingerprint <> old.request_fingerprint or new.subject_ref <> old.subject_ref
     or new.created_at <> old.created_at then
    raise exception 'Operation identity fields are fixed once recorded' using errcode = 'check_violation';
  end if;
  if new.status is distinct from old.status and not public.operation_transition_allowed(old.status, new.status) then
    raise exception 'Operation status % to % is not allowed', old.status, new.status using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger operation_ledger_guard
  before update or delete on public.operation_ledger
  for each row execute function public.guard_operation_ledger();

create or replace function public.prevent_operation_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Operation attempts and ledger history cannot be truncated or changed' using errcode = 'insufficient_privilege';
end $$;

create trigger operation_attempts_append_only
  before update or delete on public.operation_attempts
  for each row execute function public.prevent_operation_change();
create trigger operation_attempts_no_truncate
  before truncate on public.operation_attempts
  for each statement execute function public.prevent_operation_change();
create trigger operation_ledger_no_truncate
  before truncate on public.operation_ledger
  for each statement execute function public.prevent_operation_change();

-- 5. begin_operation: decides whether the caller may act. Returns a jsonb decision (see the TypeScript BeginDecision).
create or replace function public.begin_operation(
  p_operation_type      text,
  p_idempotency_key     text,
  p_subject_booking_id  uuid,
  p_subject_ref         text,
  p_request_fingerprint text,
  p_actor_label         text,
  p_correlation_id      text,
  p_owner               text,
  p_lease_seconds       integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now     timestamptz := clock_timestamp();
  v_row     public.operation_ledger%rowtype;
  v_busy    public.operation_ledger%rowtype;
  v_id      uuid;
  v_attempt integer;
begin
  if p_operation_type is null or p_operation_type not in ('booking.create', 'supplier.order', 'supplier.cancel', 'payment.start', 'payment.capture_request', 'payment.release', 'payment.refund') then
    raise exception 'Unknown operation type' using errcode = 'check_violation';
  end if;
  if p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'A request fingerprint is required' using errcode = 'check_violation';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then
    return jsonb_build_object('decision', 'refused', 'reason', 'lease out of range');
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' or p_owner is null or btrim(p_owner) = ''
     or p_actor_label is null or btrim(p_actor_label) = '' or p_correlation_id is null or btrim(p_correlation_id) = '' then
    return jsonb_build_object('decision', 'refused', 'reason', 'key, owner, actor and correlation are required');
  end if;

  -- Serialise every begin for this key, and for this subject when the type is subject-unique.
  perform pg_advisory_xact_lock(hashtext(p_operation_type || '|key|' || p_idempotency_key));
  if p_operation_type in ('supplier.order', 'supplier.cancel', 'payment.start', 'payment.capture_request', 'payment.release', 'payment.refund') then
    perform pg_advisory_xact_lock(hashtext(p_operation_type || '|subject|' || p_subject_ref));
  end if;

  select * into v_row from public.operation_ledger
    where operation_type = p_operation_type and idempotency_key = p_idempotency_key for update;
  if found then
    if v_row.request_fingerprint <> p_request_fingerprint then
      return jsonb_build_object('decision', 'key_reused', 'operation_id', v_row.id);
    end if;
    if v_row.status = 'succeeded' then
      return jsonb_build_object('decision', 'already_succeeded', 'operation_id', v_row.id, 'result_ref', v_row.result_ref);
    elsif v_row.status = 'failed_terminal' then
      return jsonb_build_object('decision', 'terminal_failure', 'operation_id', v_row.id, 'failure_code', v_row.failure_code);
    elsif v_row.status = 'unknown' then
      return jsonb_build_object('decision', 'needs_reconciliation', 'operation_id', v_row.id);
    elsif v_row.status = 'in_progress' then
      if v_row.lease_expires_at > v_now then
        return jsonb_build_object('decision', 'in_progress', 'operation_id', v_row.id);
      end if;
      if p_operation_type in ('supplier.order', 'supplier.cancel', 'payment.start', 'payment.capture_request', 'payment.release', 'payment.refund') then
        -- An external operation whose holder stopped responding is unknown. It is never retried automatically.
        perform set_config('go.operation_authority', 'ledger_function', true);
        update public.operation_ledger
          set status = 'unknown', lease_owner = null, lease_expires_at = null, failure_code = 'lease_expired', updated_at = v_now
          where id = v_row.id;
        perform set_config('go.operation_authority', '', true);
        insert into public.operation_attempts (operation_id, attempt_no, event, status_after, lease_owner, failure_code, actor_label, correlation_id, occurred_at)
          values (v_row.id, v_row.attempt_count, 'lease_expired_unknown', 'unknown', v_row.lease_owner, 'lease_expired', p_actor_label, p_correlation_id, v_now);
        return jsonb_build_object('decision', 'needs_reconciliation', 'operation_id', v_row.id);
      end if;
      -- booking.create is one database transaction: nothing outside was changed, so a new holder may take over.
      v_attempt := v_row.attempt_count + 1;
      perform set_config('go.operation_authority', 'ledger_function', true);
      update public.operation_ledger
        set lease_owner = p_owner, lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
            attempt_count = v_attempt, updated_at = v_now
        where id = v_row.id;
      perform set_config('go.operation_authority', '', true);
      insert into public.operation_attempts (operation_id, attempt_no, event, status_after, lease_owner, actor_label, correlation_id, occurred_at)
        values (v_row.id, v_attempt, 'lease_taken_over', 'in_progress', p_owner, p_actor_label, p_correlation_id, v_now);
      return jsonb_build_object('decision', 'started', 'operation_id', v_row.id, 'attempt_no', v_attempt, 'takeover', true);
    else
      -- failed_retryable: the next attempt, under the same key.
      v_attempt := v_row.attempt_count + 1;
      perform set_config('go.operation_authority', 'ledger_function', true);
      update public.operation_ledger
        set status = 'in_progress', lease_owner = p_owner, lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
            attempt_count = v_attempt, failure_code = null, updated_at = v_now
        where id = v_row.id;
      perform set_config('go.operation_authority', '', true);
      insert into public.operation_attempts (operation_id, attempt_no, event, status_after, lease_owner, actor_label, correlation_id, occurred_at)
        values (v_row.id, v_attempt, 'started', 'in_progress', p_owner, p_actor_label, p_correlation_id, v_now);
      return jsonb_build_object('decision', 'started', 'operation_id', v_row.id, 'attempt_no', v_attempt, 'takeover', false);
    end if;
  end if;

  -- A new key. For subject-unique types, a live operation for the same subject holds the subject.
  if p_operation_type in ('supplier.order', 'supplier.cancel', 'payment.start', 'payment.capture_request', 'payment.release', 'payment.refund') then
    select * into v_busy from public.operation_ledger
      where operation_type = p_operation_type and subject_ref = p_subject_ref and status in ('in_progress', 'succeeded', 'unknown')
      limit 1;
    if found then
      return jsonb_build_object('decision', 'subject_busy', 'operation_id', v_busy.id);
    end if;
  end if;

  insert into public.operation_ledger (
    operation_type, idempotency_key, subject_booking_id, subject_ref, status, request_fingerprint, attempt_count,
    lease_owner, lease_expires_at, actor_kind, actor_label, correlation_id, created_at, updated_at
  ) values (
    p_operation_type, p_idempotency_key, p_subject_booking_id, p_subject_ref, 'in_progress', p_request_fingerprint, 1,
    p_owner, v_now + make_interval(secs => p_lease_seconds), 'backend_workflow', p_actor_label, p_correlation_id, v_now, v_now
  ) returning id into v_id;
  insert into public.operation_attempts (operation_id, attempt_no, event, status_after, lease_owner, actor_label, correlation_id, occurred_at)
    values (v_id, 1, 'started', 'in_progress', p_owner, p_actor_label, p_correlation_id, v_now);
  return jsonb_build_object('decision', 'started', 'operation_id', v_id, 'attempt_no', 1, 'takeover', false);
end $$;

-- 6. complete_operation: records the result. Only the current lease holder may record it (fencing).
create or replace function public.complete_operation(
  p_operation_id  uuid,
  p_owner         text,
  p_outcome       text,
  p_result_ref    text,
  p_failure_code  text,
  p_correlation_id text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.operation_ledger%rowtype;
begin
  select * into v_row from public.operation_ledger where id = p_operation_id for update;
  if not found then
    raise exception 'Unknown operation' using errcode = 'check_violation';
  end if;
  if v_row.status <> 'in_progress' or v_row.lease_owner is distinct from p_owner then
    insert into public.operation_attempts (operation_id, attempt_no, event, status_after, lease_owner, actor_label, correlation_id, occurred_at)
      values (v_row.id, v_row.attempt_count, 'stale_completion_rejected', v_row.status, p_owner, 'backend_workflow', p_correlation_id, v_now);
    return 'rejected_stale';
  end if;
  if p_outcome = 'succeeded' then
    if p_result_ref is null or btrim(p_result_ref) = '' then
      raise exception 'A succeeded operation needs a result reference' using errcode = 'check_violation';
    end if;
  elsif p_outcome in ('failed_retryable', 'failed_terminal', 'unknown') then
    if p_failure_code is null or btrim(p_failure_code) = '' then
      raise exception 'A failure needs a failure code' using errcode = 'check_violation';
    end if;
  else
    raise exception 'Unknown outcome' using errcode = 'check_violation';
  end if;
  if not public.operation_transition_allowed('in_progress', p_outcome) then
    raise exception 'Operation status in_progress to % is not allowed', p_outcome using errcode = 'check_violation';
  end if;

  perform set_config('go.operation_authority', 'ledger_function', true);
  update public.operation_ledger
    set status = p_outcome,
        result_ref = case when p_outcome = 'succeeded' then p_result_ref else null end,
        failure_code = case when p_outcome = 'succeeded' then null else p_failure_code end,
        lease_owner = null, lease_expires_at = null,
        completed_at = case when p_outcome in ('succeeded', 'failed_terminal') then v_now else null end,
        updated_at = v_now
    where id = v_row.id;
  perform set_config('go.operation_authority', '', true);

  insert into public.operation_attempts (operation_id, attempt_no, event, status_after, lease_owner, failure_code, actor_label, correlation_id, occurred_at)
    values (v_row.id, v_row.attempt_count, p_outcome, p_outcome, p_owner,
            case when p_outcome = 'succeeded' then null else p_failure_code end, 'backend_workflow', p_correlation_id, v_now);
  return 'completed';
end $$;

-- 7. renew_operation_lease: the lease holder extends its lease while a long call is still running.
create or replace function public.renew_operation_lease(p_operation_id uuid, p_owner text, p_lease_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.operation_ledger%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then
    return false;
  end if;
  select * into v_row from public.operation_ledger where id = p_operation_id for update;
  if not found or v_row.status <> 'in_progress' or v_row.lease_owner is distinct from p_owner then
    return false;
  end if;
  perform set_config('go.operation_authority', 'ledger_function', true);
  update public.operation_ledger
    set lease_expires_at = v_now + make_interval(secs => p_lease_seconds), updated_at = v_now
    where id = v_row.id;
  perform set_config('go.operation_authority', '', true);
  return true;
end $$;

-- 8. reconcile_operation: resolves an unknown operation only with evidence from the supplier or provider, and only
--    from a reconciliation actor. Returns 'reconciled' or 'refused'.
create or replace function public.reconcile_operation(
  p_operation_id  uuid,
  p_outcome       text,
  p_result_ref    text,
  p_failure_code  text,
  p_evidence_ref  text,
  p_actor_label   text,
  p_correlation_id text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.operation_ledger%rowtype;
  v_event text;
begin
  select * into v_row from public.operation_ledger where id = p_operation_id for update;
  if not found or v_row.status <> 'unknown' then
    return 'refused';
  end if;
  if p_actor_label is null or not starts_with(p_actor_label, 'reconciliation:') or p_evidence_ref is null or btrim(p_evidence_ref) = '' then
    return 'refused';
  end if;
  if p_outcome = 'succeeded' then
    if p_result_ref is null or btrim(p_result_ref) = '' then
      raise exception 'A reconciled success needs a result reference' using errcode = 'check_violation';
    end if;
    v_event := 'reconciled_succeeded';
  elsif p_outcome in ('failed_retryable', 'failed_terminal') then
    if p_failure_code is null or btrim(p_failure_code) = '' then
      raise exception 'A reconciled failure needs a failure code' using errcode = 'check_violation';
    end if;
    v_event := case when p_outcome = 'failed_terminal' then 'reconciled_failed_terminal' else 'reconciled_failed_retryable' end;
  else
    raise exception 'Unknown reconciled outcome' using errcode = 'check_violation';
  end if;
  if not public.operation_transition_allowed('unknown', p_outcome) then
    raise exception 'Operation status unknown to % is not allowed', p_outcome using errcode = 'check_violation';
  end if;

  perform set_config('go.operation_authority', 'ledger_function', true);
  update public.operation_ledger
    set status = p_outcome,
        result_ref = case when p_outcome = 'succeeded' then p_result_ref else null end,
        failure_code = case when p_outcome = 'succeeded' then null else p_failure_code end,
        completed_at = case when p_outcome in ('succeeded', 'failed_terminal') then v_now else null end,
        actor_kind = 'reconciliation', actor_label = p_actor_label, updated_at = v_now
    where id = v_row.id;
  perform set_config('go.operation_authority', '', true);

  insert into public.operation_attempts (operation_id, attempt_no, event, status_after, failure_code, evidence_ref, actor_label, correlation_id, occurred_at)
    values (v_row.id, v_row.attempt_count, v_event, p_outcome,
            case when p_outcome = 'succeeded' then null else p_failure_code end, p_evidence_ref, p_actor_label, p_correlation_id, v_now);
  return 'reconciled';
end $$;

-- 9. Privileges. Only the service role runs the functions. Signed-in administrators with MFA may read.
alter table public.operation_ledger enable row level security;
alter table public.operation_attempts enable row level security;
revoke all on public.operation_ledger from public, anon, authenticated;
revoke all on public.operation_attempts from public, anon, authenticated;
create policy operation_ledger_admin_read on public.operation_ledger for select to authenticated using (public.is_admin_mfa());
create policy operation_attempts_admin_read on public.operation_attempts for select to authenticated using (public.is_admin_mfa());
grant select on public.operation_ledger to authenticated;
grant select on public.operation_attempts to authenticated;

revoke execute on function public.operation_transition_allowed(text, text) from public, anon, authenticated;
revoke execute on function public.guard_operation_ledger() from public, anon, authenticated;
revoke execute on function public.prevent_operation_change() from public, anon, authenticated;
revoke execute on function public.begin_operation(text, text, uuid, text, text, text, text, text, integer) from public, anon, authenticated;
revoke execute on function public.complete_operation(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.renew_operation_lease(uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.reconcile_operation(uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.begin_operation(text, text, uuid, text, text, text, text, text, integer) to service_role;
grant execute on function public.complete_operation(uuid, text, text, text, text, text) to service_role;
grant execute on function public.renew_operation_lease(uuid, text, integer) to service_role;
grant execute on function public.reconcile_operation(uuid, text, text, text, text, text, text) to service_role;
-- The service role reads the ledger for reconciliation and reporting. It writes only through the functions above.
grant select on public.operation_ledger, public.operation_attempts to service_role;

commit;
