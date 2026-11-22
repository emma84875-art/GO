-- Phase 14 remediation, applied after 20261112000000_initial_schema.sql.
--   1. Payments: match the code, one live payment per booking (database enforced), webhook dedupe.
--   2. Tickets: ticket numbers encrypted at rest; no plaintext column.
--   3. Passengers: assignment-based staff access, reads logged, through one audited function.
--   4. Staff access requires a multi-factor session (aal2) for every staff policy.
-- These tables are new or pre-launch and must be empty when this runs. The guards below stop the
-- migration if that is not true, so no data is silently rewritten.

-- ---------------------------------------------------------------------------
-- 0. Guards
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.payments) then raise exception 'payments must be empty for this migration (pre-launch only)'; end if;
  if exists (select 1 from public.tickets) then raise exception 'tickets must be empty for this migration (pre-launch only)'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Payments
-- ---------------------------------------------------------------------------
alter table public.payments drop column processed_event_ids;
alter table public.payments
  add column reference       text not null,
  add column expires_at      timestamptz not null,
  add column captured_minor  bigint not null default 0 check (captured_minor >= 0),
  add column refunded_minor  bigint not null default 0 check (refunded_minor >= 0),
  add constraint payments_amount_positive check (amount_minor > 0),
  add constraint payments_refunded_within_captured check (refunded_minor <= captured_minor);

-- Our idempotency reference is sent to the provider, so it must be unique per attempt.
create unique index payments_reference_key on public.payments (reference);

-- One live payment per booking. Concurrent requests cannot both insert a live row: the second
-- insert fails. Live means the same set as LIVE_STATUSES in packages/payments/src/state.ts.
create unique index payments_one_live_per_booking on public.payments (booking_id)
  where status in ('initiated', 'authorised', 'captured', 'refund_pending', 'review_required');

-- Webhook dedupe, durable. A repeated (provider, dedupe key) insert fails with unique_violation.
-- Only server code (service role) reads or writes it.
create table public.payment_webhook_events (
  provider     text not null check (provider in ('fixture', 'paystack', 'flutterwave')),
  dedupe_key   text not null check (length(dedupe_key) between 1 and 300),
  received_at  timestamptz not null default now(),
  primary key (provider, dedupe_key)
);
alter table public.payment_webhook_events enable row level security;
revoke all on public.payment_webhook_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Tickets: encrypted ticket numbers
-- ---------------------------------------------------------------------------
-- The ciphertext is produced by packages/security/src/field-crypto.ts ("v1.<keyId>.<iv>.<tag>.<ct>"),
-- bound to the row with an additional-data string. The hash is an HMAC of the number, used only to
-- detect duplicates; it cannot be reversed without the key. Staff never see the plaintext.
alter table public.tickets
  drop column ticket_number,
  add column ticket_number_ciphertext text not null check (ticket_number_ciphertext like 'v1.%'),
  add column ticket_number_key_id     text not null check (ticket_number_key_id ~ '^[a-z0-9_-]{1,32}$'),
  add column ticket_number_hash       text not null check (length(ticket_number_hash) = 64),
  add constraint tickets_number_hash_unique unique (ticket_number_hash);

-- ---------------------------------------------------------------------------
-- 3. Staff MFA helpers
-- ---------------------------------------------------------------------------
-- The session must be an MFA session (aal2) for any staff access. aal comes from the verified JWT.
create or replace function public.is_staff_mfa()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_app_role() in ('support', 'admin')
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

create or replace function public.is_admin_mfa()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_app_role() = 'admin'
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

-- ---------------------------------------------------------------------------
-- 4. Assignment-based staff access and read logging
-- ---------------------------------------------------------------------------
-- A staff member may see a booking's passengers only while an active assignment exists. Only server
-- code (service role, acting for an admin) creates or revokes assignments.
create table public.support_assignments (
  id           bigint generated always as identity primary key,
  booking_id   uuid not null references public.bookings (id) on delete restrict,
  staff_id     uuid not null references public.profiles (id) on delete restrict,
  assigned_by  uuid not null references public.profiles (id) on delete restrict,
  assigned_at  timestamptz not null default now(),
  revoked_at   timestamptz,
  check (revoked_at is null or revoked_at >= assigned_at)
);
create unique index support_assignments_one_active on public.support_assignments (booking_id, staff_id)
  where revoked_at is null;

-- Every passenger read by staff. Append-only, written only by staff_passenger_details().
create table public.passenger_access_log (
  id           bigint generated always as identity primary key,
  staff_id     uuid not null,
  booking_id   uuid not null,
  fields       text[] not null,
  accessed_at  timestamptz not null default now()
);

create trigger passenger_access_log_append_only
  before update or delete on public.passenger_access_log
  for each row execute function public.prevent_audit_mutation();

create trigger passenger_access_log_no_truncate
  before truncate on public.passenger_access_log
  for each statement execute function public.prevent_audit_mutation();

-- The one way staff read passenger details. It checks MFA and an active assignment, logs the read
-- before returning anything, and returns only the fields a support agent needs.
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

revoke execute on function public.staff_passenger_details(uuid) from public, anon;
grant execute on function public.staff_passenger_details(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Row level security: replace staff policies with MFA-gated ones
-- ---------------------------------------------------------------------------
alter table public.support_assignments enable row level security;
alter table public.passenger_access_log enable row level security;

revoke insert, update, delete on public.support_assignments from authenticated;
revoke all on public.passenger_access_log from anon, authenticated;
grant select on public.passenger_access_log to authenticated;

create policy support_assignments_select on public.support_assignments for select to authenticated
  using ((staff_id = auth.uid() and public.is_staff_mfa()) or public.is_admin_mfa());

create policy passenger_access_log_select_admin on public.passenger_access_log for select to authenticated
  using (public.is_admin_mfa());

drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin_mfa());

drop policy searches_select_own on public.searches;
create policy searches_select_own on public.searches for select to authenticated
  using (user_id = auth.uid() or public.is_staff_mfa());

drop policy bookings_select on public.bookings;
create policy bookings_select on public.bookings for select to authenticated
  using (user_id = auth.uid() or public.is_staff_mfa());

drop policy booking_segments_select on public.booking_segments;
create policy booking_segments_select on public.booking_segments for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id
    and (b.user_id = auth.uid() or public.is_staff_mfa())));

-- Passengers: customers see their own bookings only. Staff use staff_passenger_details().
drop policy passengers_select on public.passengers;
create policy passengers_select_own on public.passengers for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id and b.user_id = auth.uid()));

drop policy payments_select on public.payments;
create policy payments_select on public.payments for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id
    and (b.user_id = auth.uid() or public.is_staff_mfa())));

drop policy tickets_select on public.tickets;
create policy tickets_select on public.tickets for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id
    and (b.user_id = auth.uid() or public.is_staff_mfa())));

drop policy audit_log_select_admin on public.audit_log;
create policy audit_log_select_admin on public.audit_log for select to authenticated
  using (public.is_admin_mfa());
