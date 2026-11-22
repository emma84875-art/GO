-- Phase 15: staff roles, MFA enforcement and role-change hardening.
--   1. Adds the operations role. Operations staff read bookings, payments and tickets, but not passenger
--      details. Support staff and administrators keep passenger access through the assignment function.
--   2. A staff role can be granted only to an account with a verified multi-factor method (auth.mfa_factors).
--   3. Role changes need an administrator in an MFA session (aal2), not just an administrator role.
--   4. staff_passenger_details() refuses every role except support and admin, even with an assignment.
--
-- The role check of profiles keeps its name (profiles_role_check), so it is replaced by name.

-- ---------------------------------------------------------------------------
-- 1. Operations role
-- ---------------------------------------------------------------------------
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('customer', 'support', 'operations', 'admin'));

-- Any MFA-verified staff member (support, operations or admin). Customers never qualify.
create or replace function public.is_staff_mfa()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_app_role() in ('support', 'operations', 'admin')
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

-- ---------------------------------------------------------------------------
-- 2. Staff roles need a verified MFA method
-- ---------------------------------------------------------------------------
create or replace function public.require_verified_mfa_for_staff()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.role in ('support', 'operations', 'admin')
     and (tg_op = 'INSERT' or new.role is distinct from old.role) then
    if not exists (
      select 1 from auth.mfa_factors f
      where f.user_id = new.id and f.status = 'verified'
    ) then
      raise exception 'Staff accounts require a verified multi-factor method before a staff role is granted';
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_require_mfa_for_staff
  before insert or update of role on public.profiles
  for each row execute function public.require_verified_mfa_for_staff();

-- ---------------------------------------------------------------------------
-- 3. Role changes: administrator in an MFA session, or the service role (logged server path)
-- ---------------------------------------------------------------------------
create or replace function public.guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.role is distinct from old.role then
    if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
       and not public.is_admin_mfa() then
      raise exception 'Only an administrator in a multi-factor session can change a user role';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Passenger details: support and administrators only
-- ---------------------------------------------------------------------------
create or replace function public.staff_passenger_details(p_booking_id uuid)
returns table (passenger_id uuid, first_name text, last_name text, date_of_birth date, nationality char(2))
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if not public.is_staff_mfa() then
    raise exception 'staff access requires a multi-factor session' using errcode = '42501';
  end if;
  -- Operations staff never see passenger details, whatever their assignments.
  if public.current_app_role() not in ('support', 'admin') then
    raise exception 'this role cannot read passenger details' using errcode = '42501';
  end if;
  -- Admins need an assignment too. There is no role bypass.
  if not exists (
    select 1 from public.support_assignments a
    where a.booking_id = p_booking_id and a.staff_id = v_uid and a.revoked_at is null
  ) then
    raise exception 'no active assignment for this booking' using errcode = '42501';
  end if;

  insert into public.passenger_access_log (staff_id, booking_id, fields)
  values (v_uid, p_booking_id, array['first_name', 'last_name', 'date_of_birth', 'nationality']);

  return query
    select p.id, p.first_name, p.last_name, p.date_of_birth, p.nationality
    from public.passengers p
    where p.booking_id = p_booking_id;
end;
$$;
