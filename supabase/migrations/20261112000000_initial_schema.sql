-- Initial schema for the flight booking platform.
-- Conventions:
--   * Every table has row level security enabled. No table is open by default.
--   * Money is stored as integer minor units with an explicit currency code.
--   * Reservation status and ticket status are separate columns.
--   * Customers have read access to their own data only. All writes that change
--     bookings, payments or tickets go through server code using the service role.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Profiles (one per auth user)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  role        text not null default 'customer' check (role in ('customer', 'support', 'admin')),
  full_name   text,
  country     char(2),
  phone       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Helper: the calling user's role. Security definer so policies can use it
-- without recursing into the profiles policies.
create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- Creates a profile when a new auth user signs up. Role is always 'customer'.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role) values (new.id, 'customer');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Users may edit their own profile, but must never change their own role.
-- Only the service role (server code) or an admin may change a role.
create or replace function public.guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role then
    if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
       and public.current_app_role() is distinct from 'admin' then
      raise exception 'Only an administrator can change a user role';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_guard_role
  before update on public.profiles
  for each row execute function public.guard_profile_role();

-- ---------------------------------------------------------------------------
-- Searches
-- ---------------------------------------------------------------------------
create table public.searches (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid references public.profiles (id) on delete set null,
  origin             char(3) not null check (origin ~ '^[A-Z]{3}$'),
  destination        char(3) not null check (destination ~ '^[A-Z]{3}$'),
  departure_date     date not null,
  passengers         smallint not null check (passengers between 1 and 9),
  cabin              text not null check (cabin in ('economy', 'premium_economy', 'business', 'first')),
  display_currency   char(3) not null check (display_currency in ('NGN', 'USD', 'GBP', 'EUR')),
  created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------
create table public.bookings (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references public.profiles (id) on delete restrict,
  reservation_status       text not null default 'draft' check (reservation_status in (
    'draft', 'quoted', 'pending_payment', 'payment_confirmed',
    'reservation_pending', 'reservation_confirmed', 'reservation_failed')),
  ticket_status            text not null default 'not_issued' check (ticket_status in (
    'not_issued', 'ticketing_pending', 'ticketed', 'ticketing_failed')),
  supplier_name            text,
  supplier_order_id        text,
  -- Supplier price (settlement currency) and customer price (display currency).
  supplier_currency        char(3) check (supplier_currency in ('NGN', 'USD', 'GBP', 'EUR')),
  supplier_amount_minor    bigint check (supplier_amount_minor is null or supplier_amount_minor >= 0),
  display_currency         char(3) not null check (display_currency in ('NGN', 'USD', 'GBP', 'EUR')),
  display_amount_minor     bigint not null check (display_amount_minor >= 0),
  -- FX rate snapshot used to produce the display amount.
  fx_rate                  numeric(18, 8),
  fx_rate_at               timestamptz,
  offer_snapshot           jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- A ticket can only exist for a confirmed reservation.
  constraint ticketed_requires_confirmed_reservation check (
    ticket_status <> 'ticketed' or reservation_status = 'reservation_confirmed'),
  constraint ticketing_requires_confirmed_reservation check (
    ticket_status not in ('ticketing_pending', 'ticketed') or reservation_status = 'reservation_confirmed')
);

create index bookings_user_id_idx on public.bookings (user_id);

create table public.booking_segments (
  id                    uuid primary key default gen_random_uuid(),
  booking_id            uuid not null references public.bookings (id) on delete cascade,
  position              smallint not null check (position >= 1),
  origin                char(3) not null check (origin ~ '^[A-Z]{3}$'),
  destination           char(3) not null check (destination ~ '^[A-Z]{3}$'),
  departure_utc         timestamptz not null,
  arrival_utc           timestamptz not null,
  departure_time_zone   text not null,
  arrival_time_zone     text not null,
  carrier               char(2) not null,
  flight_number         text not null,
  unique (booking_id, position),
  check (arrival_utc > departure_utc)
);

create table public.passengers (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid not null references public.bookings (id) on delete cascade,
  first_name      text not null,
  last_name       text not null,
  date_of_birth   date not null,
  nationality     char(2) not null
  -- Travel document numbers are intentionally not stored here. Their storage
  -- (encryption, retention and access) needs approval first. See docs/02-architecture.md.
);

create index passengers_booking_id_idx on public.passengers (booking_id);

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
create table public.payments (
  id                   uuid primary key default gen_random_uuid(),
  booking_id           uuid not null references public.bookings (id) on delete restrict,
  provider             text not null check (provider in ('mock', 'paystack', 'flutterwave', 'stripe', 'crypto')),
  provider_reference   text not null,
  amount_minor         bigint not null check (amount_minor >= 0),
  currency             char(3) not null check (currency in ('NGN', 'USD', 'GBP', 'EUR')),
  status               text not null check (status in ('initiated', 'succeeded', 'failed', 'refunded')),
  -- Webhook event IDs already processed, for idempotency.
  processed_event_ids  text[] not null default '{}',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (provider, provider_reference)
);

create index payments_booking_id_idx on public.payments (booking_id);

-- ---------------------------------------------------------------------------
-- Tickets (written only by server code, from supplier responses)
-- ---------------------------------------------------------------------------
create table public.tickets (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid not null references public.bookings (id) on delete restrict,
  passenger_id    uuid not null references public.passengers (id) on delete restrict,
  ticket_number   text not null unique,
  issued_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Audit log (append only, written by server code)
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id           bigint generated always as identity primary key,
  actor_id     uuid,
  action       text not null,
  entity       text not null,
  entity_id    text,
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

-- The audit log is append only for every role, including the service role.
create or replace function public.prevent_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append only';
end;
$$;

create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function public.prevent_audit_mutation();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.profiles         enable row level security;
alter table public.searches         enable row level security;
alter table public.bookings         enable row level security;
alter table public.booking_segments enable row level security;
alter table public.passengers       enable row level security;
alter table public.payments         enable row level security;
alter table public.tickets          enable row level security;
alter table public.audit_log        enable row level security;

-- Profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.current_app_role() = 'admin');
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Searches
create policy searches_select_own on public.searches for select to authenticated
  using (user_id = auth.uid() or public.current_app_role() in ('support', 'admin'));
create policy searches_insert_own on public.searches for insert to authenticated
  with check (user_id = auth.uid());

-- Bookings: customers read their own; staff read all. No customer writes.
create policy bookings_select on public.bookings for select to authenticated
  using (user_id = auth.uid() or public.current_app_role() in ('support', 'admin'));

-- Booking children: visible through the parent booking.
create policy booking_segments_select on public.booking_segments for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id
    and (b.user_id = auth.uid() or public.current_app_role() in ('support', 'admin'))));

create policy passengers_select on public.passengers for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id
    and (b.user_id = auth.uid() or public.current_app_role() in ('support', 'admin'))));

create policy payments_select on public.payments for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id
    and (b.user_id = auth.uid() or public.current_app_role() in ('support', 'admin'))));

create policy tickets_select on public.tickets for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id
    and (b.user_id = auth.uid() or public.current_app_role() in ('support', 'admin'))));

-- Audit log: admins read only. Nobody writes through the API; the service role
-- inserts and bypasses RLS.
create policy audit_log_select_admin on public.audit_log for select to authenticated
  using (public.current_app_role() = 'admin');

-- Explicit privilege hardening: the anon role has no access to application tables.
revoke all on all tables in schema public from anon;
revoke insert, update, delete on public.audit_log from authenticated;
revoke update, delete on public.bookings from authenticated;
revoke insert, update, delete on public.booking_segments, public.passengers,
  public.payments, public.tickets from authenticated;
