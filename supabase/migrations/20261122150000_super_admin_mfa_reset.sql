-- Phase 15 (owner decision 3): super administrators and staff MFA resets.
--   * Only a designated super administrator may start a staff MFA reset.
--   * Every reset needs: a documented reason, identity verified by a different super administrator, a
--     notice to the affected staff member, and completion by a third party to the requester.
--   * A super administrator cannot reset their own factor, and cannot be the target of a staff reset.
--     Super administrator recovery follows a separate, documented procedure (docs/20).
--   * At least two active super administrators must remain at all times.
--   * Every step writes to the append-only audit log.
--   * Removing factors is done by server code with the service role (Supabase Admin API). The database
--     records the decision and the evidence, and completion can only be recorded after the notice.

-- ---------------------------------------------------------------------------
-- 1. Super administrator designation
-- ---------------------------------------------------------------------------
create table public.super_administrators (
  user_id        uuid primary key references public.profiles (id) on delete restrict,
  designated_at  timestamptz not null default now(),
  -- A label for the designating process, for example 'owner-approval-2026-11-22'. No personal data.
  designated_by  text not null check (length(btrim(designated_by)) between 1 and 120),
  revoked_at     timestamptz,
  check (revoked_at is null or revoked_at >= designated_at)
);

alter table public.super_administrators enable row level security;
revoke all on public.super_administrators from anon, authenticated;
grant select on public.super_administrators to authenticated;

-- Only an administrator with a verified MFA method can be designated. Designation itself is server
-- work (service role).
create or replace function public.require_admin_for_super_admin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
      raise exception 'A revoked super administrator designation cannot be restored. Designate again instead.';
    end if;
    if old.revoked_at is null and new.revoked_at is not null then
      if (select count(*) from public.super_administrators s
          where s.revoked_at is null and s.user_id <> new.user_id) < 2 then
        raise exception 'At least two active super administrators must remain';
      end if;
    end if;
    return new;
  end if;

  if not exists (select 1 from public.profiles p where p.id = new.user_id and p.role = 'admin') then
    raise exception 'Only an administrator can be designated super administrator';
  end if;
  if not exists (select 1 from auth.mfa_factors f where f.user_id = new.user_id and f.status = 'verified') then
    raise exception 'A super administrator needs a verified multi-factor method';
  end if;
  return new;
end;
$$;

create trigger super_administrators_guard
  before insert or update on public.super_administrators
  for each row execute function public.require_admin_for_super_admin();

revoke execute on function public.require_admin_for_super_admin() from public, anon, authenticated;

-- An active super administrator in an MFA session.
create or replace function public.is_super_admin_mfa()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin_mfa() and exists (
    select 1 from public.super_administrators s
    where s.user_id = auth.uid() and s.revoked_at is null
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. Staff MFA resets
-- ---------------------------------------------------------------------------
create table public.staff_mfa_resets (
  id                       uuid primary key default gen_random_uuid(),
  target_user_id           uuid not null references public.profiles (id) on delete restrict,
  target_role              text not null check (target_role in ('support', 'operations', 'admin')),
  requested_by             uuid not null references public.profiles (id) on delete restrict,
  reason                   text not null check (length(btrim(reason)) between 20 and 1000),
  requested_at             timestamptz not null default now(),
  identity_verified_by     uuid references public.profiles (id) on delete restrict,
  identity_method          text check (identity_method in (
    'in_person', 'video_call_with_photo_id', 'callback_to_registered_number')),
  identity_verified_at     timestamptz,
  target_notified_at       timestamptz,
  completed_by             uuid references public.profiles (id) on delete restrict,
  completed_at             timestamptz,
  cancelled_at             timestamptz,
  constraint staff_mfa_resets_not_self check (requested_by <> target_user_id),
  constraint staff_mfa_resets_independent_verifier check (
    identity_verified_by is null or identity_verified_by <> requested_by),
  constraint staff_mfa_resets_verification_complete check (
    (identity_verified_by is null) = (identity_verified_at is null)
    and (identity_verified_by is null) = (identity_method is null)),
  constraint staff_mfa_resets_completion_requires_evidence check (
    completed_at is null or (
      identity_verified_at is not null
      and target_notified_at is not null
      and completed_by is not null
      and completed_by <> requested_by)),
  constraint staff_mfa_resets_one_outcome check (completed_at is null or cancelled_at is null)
);

create index staff_mfa_resets_open_target on public.staff_mfa_resets (target_user_id)
  where completed_at is null and cancelled_at is null;

alter table public.staff_mfa_resets enable row level security;
revoke all on public.staff_mfa_resets from anon, authenticated;
grant select on public.staff_mfa_resets to authenticated;

create policy staff_mfa_resets_select_super_admin on public.staff_mfa_resets for select to authenticated
  using (public.is_super_admin_mfa());

-- Open a reset. Only a super administrator in an MFA session.
create or replace function public.request_staff_mfa_reset(p_target uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_role text;
begin
  if not public.is_super_admin_mfa() then
    raise exception 'Only a super administrator in a multi-factor session can start a staff MFA reset'
      using errcode = '42501';
  end if;
  if p_target = auth.uid() then
    raise exception 'A super administrator cannot reset their own multi-factor method';
  end if;
  select p.role into v_role from public.profiles p where p.id = p_target;
  if v_role is null or v_role not in ('support', 'operations', 'admin') then
    raise exception 'The target account is not a staff account';
  end if;
  if exists (select 1 from public.super_administrators s where s.user_id = p_target and s.revoked_at is null) then
    raise exception 'A super administrator account is recovered through the separate procedure, not a staff reset';
  end if;

  insert into public.staff_mfa_resets (target_user_id, target_role, requested_by, reason)
  values (p_target, v_role, auth.uid(), p_reason)
  returning id into v_id;

  insert into public.audit_log (actor_id, action, entity, entity_id, details)
  values (auth.uid(), 'staff_mfa_reset.requested', 'staff_mfa_reset', v_id::text,
          jsonb_build_object('target_user_id', p_target, 'target_role', v_role));
  return v_id;
end;
$$;

-- Record the identity check. It must be done by a different super administrator from the requester.
create or replace function public.verify_staff_mfa_reset_identity(p_reset uuid, p_method text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.staff_mfa_resets%rowtype;
begin
  if not public.is_super_admin_mfa() then
    raise exception 'Only a super administrator in a multi-factor session can verify identity' using errcode = '42501';
  end if;
  select * into r from public.staff_mfa_resets where id = p_reset for update;
  if not found then
    raise exception 'Reset not found';
  end if;
  if r.completed_at is not null or r.cancelled_at is not null then
    raise exception 'This reset is closed';
  end if;
  if r.requested_by = auth.uid() then
    raise exception 'The requesting super administrator cannot verify the identity';
  end if;
  if r.identity_verified_at is not null then
    raise exception 'The identity check is already recorded';
  end if;

  update public.staff_mfa_resets
     set identity_verified_by = auth.uid(),
         identity_method = p_method,
         identity_verified_at = now()
   where id = p_reset;

  insert into public.audit_log (actor_id, action, entity, entity_id, details)
  values (auth.uid(), 'staff_mfa_reset.identity_verified', 'staff_mfa_reset', p_reset::text,
          jsonb_build_object('method', p_method));
end;
$$;

-- Complete the reset. Requires the identity check, the notice to the staff member, and a completer
-- other than the requester. Call this only after the server has removed the target's factors.
create or replace function public.complete_staff_mfa_reset(p_reset uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.staff_mfa_resets%rowtype;
begin
  if not public.is_super_admin_mfa() then
    raise exception 'Only a super administrator in a multi-factor session can complete a reset' using errcode = '42501';
  end if;
  select * into r from public.staff_mfa_resets where id = p_reset for update;
  if not found then
    raise exception 'Reset not found';
  end if;
  if r.completed_at is not null or r.cancelled_at is not null then
    raise exception 'This reset is closed';
  end if;
  if r.requested_by = auth.uid() then
    raise exception 'The requesting super administrator cannot complete the reset';
  end if;
  if r.identity_verified_at is null then
    raise exception 'The identity check has not been recorded';
  end if;
  if r.target_notified_at is null then
    raise exception 'The affected staff member must be notified first';
  end if;

  update public.staff_mfa_resets
     set completed_by = auth.uid(), completed_at = now()
   where id = p_reset;

  insert into public.audit_log (actor_id, action, entity, entity_id, details)
  values (auth.uid(), 'staff_mfa_reset.completed', 'staff_mfa_reset', p_reset::text,
          jsonb_build_object('target_user_id', r.target_user_id));
end;
$$;

-- Cancel an open reset. Any active super administrator may cancel.
create or replace function public.cancel_staff_mfa_reset(p_reset uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin_mfa() then
    raise exception 'Only a super administrator in a multi-factor session can cancel a reset' using errcode = '42501';
  end if;
  update public.staff_mfa_resets
     set cancelled_at = now()
   where id = p_reset and completed_at is null and cancelled_at is null;
  if not found then
    raise exception 'No open reset with that identifier';
  end if;

  insert into public.audit_log (actor_id, action, entity, entity_id, details)
  values (auth.uid(), 'staff_mfa_reset.cancelled', 'staff_mfa_reset', p_reset::text, '{}'::jsonb);
end;
$$;

revoke execute on function public.request_staff_mfa_reset(uuid, text) from public, anon;
revoke execute on function public.verify_staff_mfa_reset_identity(uuid, text) from public, anon;
revoke execute on function public.complete_staff_mfa_reset(uuid) from public, anon;
revoke execute on function public.cancel_staff_mfa_reset(uuid) from public, anon;
revoke execute on function public.is_super_admin_mfa() from public, anon;
grant execute on function public.request_staff_mfa_reset(uuid, text) to authenticated;
grant execute on function public.verify_staff_mfa_reset_identity(uuid, text) to authenticated;
grant execute on function public.complete_staff_mfa_reset(uuid) to authenticated;
grant execute on function public.cancel_staff_mfa_reset(uuid) to authenticated;
grant execute on function public.is_super_admin_mfa() to authenticated;
