-- Phase 19.1: single booking and fulfilment state model, ISO 4217 currency reference, the partner-funded
-- fulfilment model, and partner remittance tracked separately from the booking. Decision record: docs/24.
-- Risks and decisions: docs/25.
--
-- GENERATED FROM scripts/sql-templates/booking-lifecycle.sql.tpl by scripts/generate-booking-lifecycle-sql.mjs.
-- Do not edit the generated migration by hand. Change the template or the TypeScript source and regenerate.
--
-- Safety properties:
--   1. The migration stops before changing anything unless every existing booking maps unambiguously.
--   2. The whole migration runs in one transaction. A failure leaves the database as it was.
--   3. Values in the legacy columns are copied into booking_status before those columns are dropped.
--   4. The rollback in supabase/rollbacks refuses to run if it would lose information.
--   5. Partner remittance never gates a booking. Confirmation needs ticket verification and customer capture only.

begin;

-- 0. Guard: refuse any legacy booking that does not map unambiguously.
do $$
declare
  n bigint;
begin
  select count(*) into n
  from public.bookings
  where (reservation_status, ticket_status) not in (
    ('draft', 'not_issued'),
    ('quoted', 'not_issued'),
    ('pending_payment', 'not_issued'),
    ('reservation_failed', 'not_issued')
  );
  if n > 0 then
    raise exception 'Phase 19.1 stopped: % booking(s) have a legacy status with no unambiguous mapping. Nothing was changed. Resolve each booking by hand first.', n;
  end if;
end $$;

-- 1. ISO 4217 currency reference. Source: packages/core/src/currency-metadata.ts (SIX List One, 2026-09-17).
-- Ordinary currencies only. Funds and special codes are excluded, as in the application.
create table public.currency_codes (
  code        char(3) primary key check (code ~ '^[A-Z]{3}$'),
  exponent    smallint not null check (exponent between 0 and 4),
  list_status text not null check (list_status in ('current', 'legacy')),
  name        text not null check (length(name) between 1 and 120)
);

insert into public.currency_codes (code, exponent, list_status, name) values
@@CURRENCIES@@;

alter table public.currency_codes enable row level security;
create policy currency_codes_read on public.currency_codes for select to anon, authenticated using (true);
grant select on public.currency_codes to anon, authenticated;

-- Existing currency checks are replaced by foreign keys to the reference table.
alter table public.searches drop constraint searches_display_currency_check;
alter table public.searches
  add constraint searches_display_currency_fkey foreign key (display_currency) references public.currency_codes (code);

alter table public.bookings drop constraint bookings_display_currency_check;
alter table public.bookings drop constraint bookings_supplier_currency_check;
alter table public.bookings
  add constraint bookings_display_currency_fkey foreign key (display_currency) references public.currency_codes (code),
  add constraint bookings_supplier_currency_fkey foreign key (supplier_currency) references public.currency_codes (code);

alter table public.payments drop constraint payments_currency_check;
alter table public.payments
  add constraint payments_currency_fkey foreign key (currency) references public.currency_codes (code);

-- New records may use only current codes. Legacy codes stay readable on existing rows.
create or replace function public.guard_currency_bookable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_column text;
  v_code text;
begin
  foreach v_column in array tg_argv loop
    v_code := to_jsonb(new) ->> v_column;
    if v_code is not null and not exists (
      select 1 from public.currency_codes c where c.code = v_code and c.list_status = 'current'
    ) then
      raise exception 'Currency % is not a current ISO 4217 currency for new records', v_code using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end $$;

create trigger bookings_currency_bookable
  before insert or update of display_currency, supplier_currency on public.bookings
  for each row execute function public.guard_currency_bookable('display_currency', 'supplier_currency');
create trigger payments_currency_bookable
  before insert or update of currency on public.payments
  for each row execute function public.guard_currency_bookable('currency');
create trigger searches_currency_bookable
  before insert or update of display_currency on public.searches
  for each row execute function public.guard_currency_bookable('display_currency');

-- 1b. Finance role (docs/25, section 8). Finance staff with MFA handle partner remittances across bookings.
-- Finance is not an operations role: is_staff_mfa() is unchanged, so finance has no passenger or ticket access.
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('customer', 'support', 'operations', 'admin', 'finance'));

create or replace function public.require_verified_mfa_for_staff()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.role in ('support', 'operations', 'admin', 'finance')
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

-- Finance (or an administrator) in a multi-factor session.
create or replace function public.is_finance_mfa()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.current_app_role() in ('finance', 'admin')
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

revoke execute on function public.is_finance_mfa() from public, anon;
grant execute on function public.is_finance_mfa() to authenticated;

-- Finance accounts can be recovered through the staff MFA reset like any other staff account.
alter table public.staff_mfa_resets drop constraint staff_mfa_resets_target_role_check;
alter table public.staff_mfa_resets
  add constraint staff_mfa_resets_target_role_check check (target_role in ('support', 'operations', 'admin', 'finance'));

create or replace function public.request_staff_mfa_reset(p_target uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
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
  if v_role is null or v_role not in ('support', 'operations', 'admin', 'finance') then
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

-- 2. Single booking status. Replaces reservation_status and ticket_status.
alter table public.bookings add column booking_status text;

update public.bookings set booking_status = case
  when reservation_status = 'draft' then 'draft'
  when reservation_status in ('quoted', 'pending_payment') then 'quoted'
  when reservation_status = 'reservation_failed' then 'failed'
end;

alter table public.bookings
  alter column booking_status set not null,
  alter column booking_status set default 'draft',
  add constraint bookings_booking_status_check check (booking_status in (
@@STATES@@
  ));

alter table public.bookings drop column reservation_status, drop column ticket_status;

-- 3. Milestones: each is a timestamp, set once, never cleared. Remittance is not a milestone.
alter table public.bookings
  add column quoted_at                    timestamptz,
  add column authorised_at                timestamptz,
  add column partner_order_confirmed_at   timestamptz,
  add column tickets_issued_at            timestamptz,
  add column tickets_verified_at          timestamptz,
  add column captured_at                  timestamptz,
  add column confirmed_at                 timestamptz,
  add column ticketing_partner            text check (ticketing_partner is null or length(ticketing_partner) between 1 and 120),
  add column funding_model                text not null default 'partner_funded' check (funding_model = 'partner_funded'),
  add column status_reason                text check (status_reason is null or length(status_reason) <= 500);

-- Stage of each state. A state at stage N requires the milestones of stages 1 to N.
create or replace function public.booking_stage(state text)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select case state
@@STAGES@@
    else null
  end
$$;

alter table public.bookings add constraint booking_milestones_consistent check (
  (booking_stage(booking_status) < 1 or quoted_at is not null) and
  (booking_stage(booking_status) < 2 or authorised_at is not null) and
  (booking_stage(booking_status) < 3 or partner_order_confirmed_at is not null) and
  (booking_stage(booking_status) < 3 or ticketing_partner is not null) and
  (booking_stage(booking_status) < 4 or tickets_issued_at is not null) and
  (booking_stage(booking_status) < 5 or tickets_verified_at is not null) and
  (booking_stage(booking_status) < 6 or captured_at is not null) and
  (booking_stage(booking_status) < 7 or confirmed_at is not null) and
  (authorised_at is null or quoted_at is not null) and
  (partner_order_confirmed_at is null or authorised_at is not null) and
  (tickets_issued_at is null or partner_order_confirmed_at is not null) and
  (tickets_verified_at is null or tickets_issued_at is not null) and
  (captured_at is null or tickets_verified_at is not null) and
  (confirmed_at is null or captured_at is not null)
);

-- 4. Tickets: GO's independent verification is recorded per ticket.
alter table public.tickets add column verified_at timestamptz;

-- Customers read a ticket only after GO has verified it, and only while the booking is in a visible state
-- (TICKETS_VISIBLE_STATES in packages/core/src/booking-lifecycle.ts). Staff with MFA keep their access.
drop policy tickets_select on public.tickets;
create policy tickets_select on public.tickets for select to authenticated
  using (
    public.is_staff_mfa()
    or (
      tickets.verified_at is not null
      and exists (
        select 1 from public.bookings b
        where b.id = tickets.booking_id
          and b.user_id = auth.uid()
          and b.booking_status in (@@VISIBLE_STATES@@)
      )
    )
  );

-- 4b. Provider settlement is a separate money flow (core MONEY_FLOWS). It is recorded on the payment,
-- only after capture, and it never gates a booking.
alter table public.payments add column provider_settled_at timestamptz;
alter table public.payments add constraint payments_provider_settled_after_capture check (
  provider_settled_at is null or status in ('captured', 'refund_pending', 'refunded')
);

-- 4c. Partner remittance: GO's obligation to the ticketing partner under a partner agreement, if any.
-- It has its own status and never changes a booking. Every amount, currency and due date is taken from the partner
-- agreement cited on the record. The database sets no deadline. One record per booking: instalments and several
-- invoices under one booking are not representable (docs/25, section 5B).
create table public.partner_remittances (
  id                         uuid primary key default gen_random_uuid(),
  booking_id                 uuid not null unique references public.bookings (id) on delete restrict,
  status                     text not null check (status in (@@REMITTANCE_STATUSES@@)),
  agreement_reference        text not null check (length(agreement_reference) between 1 and 120),
  agreement_clause           text not null check (length(agreement_clause) between 1 and 200),
  agreement_recorded_by      uuid not null references public.profiles (id),
  agreement_recorded_at      timestamptz not null default now(),
  amount_minor               bigint check (amount_minor is null or amount_minor >= 0),
  currency                   char(3) references public.currency_codes (code),
  due_at                     timestamptz,
  no_obligation_approved_by  uuid references public.profiles (id),
  no_obligation_approved_at  timestamptz,
  no_obligation_evidence     text check (no_obligation_evidence is null or length(no_obligation_evidence) between 20 and 2000),
  payment_reference          text check (payment_reference is null or length(payment_reference) between 1 and 200),
  paid_at                    timestamptz,
  status_reason              text check (status_reason is null or length(status_reason) <= 500),
  attempt_count              integer not null default 0 check (attempt_count >= 0),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint remittance_amount_matches_status check (
    (status = 'not_required' and amount_minor is null and currency is null and due_at is null)
    or (status <> 'not_required' and amount_minor is not null and currency is not null and due_at is not null)
  ),
  constraint remittance_no_obligation_complete check (
    (status = 'not_required' and no_obligation_approved_by is not null and no_obligation_approved_at is not null
       and no_obligation_evidence is not null)
    or (status <> 'not_required' and no_obligation_approved_by is null and no_obligation_approved_at is null
       and no_obligation_evidence is null)
  ),
  constraint remittance_paid_has_reference check (status <> 'paid' or (payment_reference is not null and paid_at is not null)),
  constraint remittance_paid_at_only_when_paid check (paid_at is null or status = 'paid'),
  constraint remittance_reason_when_failed_or_review check (status not in ('failed', 'under_review') or status_reason is not null)
);

alter table public.partner_remittances enable row level security;
revoke all on public.partner_remittances from public, anon, authenticated;
grant select, insert, update on public.partner_remittances to authenticated;
-- Finance (or an administrator) in an MFA session may see and work remittances. Nobody else reads or writes them.
-- The trigger below decides which changes need an administrator.
create policy partner_remittances_finance on public.partner_remittances for all to authenticated
  using (public.is_finance_mfa())
  with check (public.is_finance_mfa());

-- Append-only audit trail. Every creation and change is recorded with its actor, both states and the reason.
-- Only the audit trigger (security definer) writes it. Nothing can update or delete a row.
create table public.partner_remittance_events (
  id            bigint generated always as identity primary key,
  remittance_id uuid not null references public.partner_remittances (id) on delete restrict,
  booking_id    uuid not null references public.bookings (id) on delete restrict,
  action        text not null check (action in ('created', 'changed')),
  actor         uuid,
  before_state  jsonb,
  after_state   jsonb not null,
  reason        text,
  recorded_at   timestamptz not null default now()
);

alter table public.partner_remittance_events enable row level security;
revoke all on public.partner_remittance_events from public, anon, authenticated;
grant select on public.partner_remittance_events to authenticated;
create policy partner_remittance_events_finance on public.partner_remittance_events for select to authenticated
  using (public.is_finance_mfa());

-- 4d. Payment controls (docs/25, section 9). A payment's status, captured amount and provider settlement change through
-- two authorised paths only, and nothing else:
--   1. request_payment_capture: the backend capture workflow, after independent ticket verification, asks for capture
--      (authorised -> capture_requested). It records the request. It does not record that money moved.
--   2. apply_payment_provider_event: a provider result, verified by webhook signature or by the provider's own status
--      lookup, sets the result (for example capture_requested -> captured). It is idempotent and checks every transition.
-- Both run only for the service role (backend). No signed-in user (finance, administrator or any other role) has any
-- write path to payments. The service role cannot write payments directly either: the guard trigger refuses every
-- financial change unless one of the two functions has set its authority for that transaction.

alter table public.payments drop column if exists processed_event_ids;   -- superseded by payment_provider_events
alter table public.payments drop constraint if exists payments_status_check;
alter table public.payments add constraint payments_status_check check (status in (@@PAYMENT_STATUSES@@));
alter table public.payments add column if not exists capture_requested_at timestamptz;
alter table public.payments drop constraint if exists payments_capture_request_time;
alter table public.payments add constraint payments_capture_request_time check (
  (status = 'capture_requested') = (capture_requested_at is not null)
  or status in ('captured', 'refund_pending', 'refunded', 'review_required')
);

-- No signed-in role may write payments at all. Finance keeps read access (amounts and references, never passenger details).
revoke update, insert, delete on public.payments from authenticated, anon;
drop policy if exists payments_finance_update on public.payments;
drop policy if exists payments_finance_select on public.payments;
create policy payments_finance_select on public.payments for select to authenticated
  using (public.is_finance_mfa());

-- Every provider event attempt, including duplicates and rejections, with its provider event ID, timestamp, type and result.
-- The actor is the provider event itself (actor_kind 'provider_event'), never a person.
create table public.payment_provider_events (
  id                 bigint generated always as identity primary key,
  provider           text not null check (provider in ('fixture', 'paystack', 'flutterwave')),
  provider_event_id  text not null check (length(provider_event_id) between 1 and 200),
  event_type         text not null check (length(event_type) between 1 and 100),
  provider_reference text not null check (length(provider_reference) between 1 and 200),
  payment_id         uuid references public.payments (id) on delete restrict,
  provider_state     text check (provider_state in ('pending', 'authorised', 'captured', 'failed', 'released', 'other')),
  amount_minor       bigint,
  currency           char(3),
  occurred_at        timestamptz not null,
  received_at        timestamptz not null default now(),
  verification       text not null check (verification in ('webhook_signature', 'provider_lookup', 'none')),
  -- Recorded as sent, so a malformed digest is itself in the audit trail. The function rejects malformed digests.
  payload_sha256     text not null check (length(payload_sha256) between 1 and 200),
  processing_result  text not null check (processing_result in (
    'applied', 'no_change', 'review_required', 'duplicate', 'rejected')),
  result_reason      text,
  actor_kind         text not null default 'provider_event' check (actor_kind = 'provider_event'),
  actor_label        text not null check (actor_label like 'provider:%'),
  called_as          text not null
);

-- Idempotency: one processed (applied, no change or review) row per provider event. A repeat is recorded as duplicate.
create unique index payment_provider_events_processed_once on public.payment_provider_events (provider, provider_event_id)
  where processing_result in ('applied', 'no_change', 'review_required');
create index payment_provider_events_payment on public.payment_provider_events (payment_id, occurred_at);

alter table public.payment_provider_events enable row level security;
revoke all on public.payment_provider_events from public, anon, authenticated;
grant select on public.payment_provider_events to authenticated;
create policy payment_provider_events_finance on public.payment_provider_events for select to authenticated
  using (public.is_finance_mfa());

-- Every financial change to a payment, with its actor: a backend capture request or a provider event.
create table public.payment_financial_events (
  id                  bigint generated always as identity primary key,
  payment_id          uuid not null references public.payments (id) on delete restrict,
  booking_id          uuid not null references public.bookings (id) on delete restrict,
  action              text not null check (action in ('capture_requested', 'status_changed', 'provider_settled')),
  from_status         text,
  to_status           text,
  actor_kind          text not null check (actor_kind in ('backend_workflow', 'provider_event')),
  actor_label         text not null check (length(actor_label) between 1 and 200),
  provider_event_row  bigint references public.payment_provider_events (id) on delete restrict,
  called_as           text not null,
  recorded_at         timestamptz not null default now(),
  check ((actor_kind = 'provider_event') = (provider_event_row is not null))
);

alter table public.payment_financial_events enable row level security;
revoke all on public.payment_financial_events from public, anon, authenticated;
grant select on public.payment_financial_events to authenticated;
create policy payment_financial_events_finance on public.payment_financial_events for select to authenticated
  using (public.is_finance_mfa());

-- Legal payment transitions, generated from PAYMENT_TRANSITIONS in packages/payments/src/state.ts.
create or replace function public.payment_transition_allowed(p_from text, p_to text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from (values
@@PAYMENT_TRANSITIONS@@
    ) as t(from_status, to_status)
    where t.from_status = p_from and t.to_status = p_to
  );
$$;

-- Guard on every change to a payment. Creation is only as initiated. Any other financial change needs the authority
-- set by one of the two functions below, and that authority is never set for a signed-in user.
create or replace function public.guard_payment_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_authority text := nullif(current_setting('go.payment_authority', true), '');
begin
  if tg_op = 'INSERT' then
    if new.status <> 'initiated' or coalesce(new.captured_minor, 0) <> 0 or new.provider_settled_at is not null then
      raise exception 'A payment is created as initiated; any other state is reached only through the payment functions'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.status is not distinct from old.status
     and new.captured_minor is not distinct from old.captured_minor
     and new.provider_settled_at is not distinct from old.provider_settled_at
     and new.capture_requested_at is not distinct from old.capture_requested_at then
    return new;
  end if;

  if auth.uid() is not null then
    raise exception 'A signed-in user cannot change a payment. Capture requests and provider results come from the backend'
      using errcode = 'check_violation';
  end if;
  if v_authority is null then
    raise exception 'A payment changes only through a backend capture request or a verified provider event'
      using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status then
    if v_authority = 'capture_request' then
      if not (old.status = 'authorised' and new.status = 'capture_requested') then
        raise exception 'A capture request can only move an authorised payment to capture_requested'
          using errcode = 'check_violation';
      end if;
    elsif v_authority = 'provider_event' then
      if new.status = 'capture_requested' then
        raise exception 'Only a backend capture request can move a payment to capture_requested'
          using errcode = 'check_violation';
      end if;
      if not public.payment_transition_allowed(old.status, new.status) then
        raise exception 'Illegal payment transition from % to %', old.status, new.status using errcode = 'check_violation';
      end if;
    else
      raise exception 'Unknown payment authority' using errcode = 'check_violation';
    end if;
  end if;

  if new.status = 'captured' and (new.captured_minor is null or new.captured_minor <= 0 or new.captured_minor > new.amount_minor) then
    raise exception 'A captured payment needs a captured amount above zero and no larger than the payment amount'
      using errcode = 'check_violation';
  end if;
  if old.status = 'captured' and new.captured_minor is distinct from old.captured_minor then
    raise exception 'A captured amount cannot change once the payment is captured' using errcode = 'check_violation';
  end if;
  if old.provider_settled_at is not null and new.provider_settled_at is distinct from old.provider_settled_at then
    raise exception 'Provider settlement is already recorded and cannot change' using errcode = 'check_violation';
  end if;
  if new.provider_settled_at is not null and new.status not in ('captured', 'refund_pending', 'refunded') then
    raise exception 'Provider settlement is recorded only for a captured payment' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger payments_state_guard
  before insert or update of status, captured_minor, provider_settled_at, capture_requested_at on public.payments
  for each row execute function public.guard_payment_state();

create or replace function public.prevent_payment_event_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Payment audit records are append-only' using errcode = 'check_violation';
end $$;

create trigger payment_provider_events_append_only
  before update or delete on public.payment_provider_events
  for each row execute function public.prevent_payment_event_change();
create trigger payment_provider_events_no_truncate
  before truncate on public.payment_provider_events
  for each statement execute function public.prevent_payment_event_change();
create trigger payment_financial_events_append_only
  before update or delete on public.payment_financial_events
  for each row execute function public.prevent_payment_event_change();
create trigger payment_financial_events_no_truncate
  before truncate on public.payment_financial_events
  for each statement execute function public.prevent_payment_event_change();

-- Step 1 of capture: the backend workflow requests capture once the booking's tickets are all independently verified.
-- Only the service role may call it. It records the request and the named workflow; it never records that money moved.
create or replace function public.request_payment_capture(p_payment_id uuid, p_workflow text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pay public.payments%rowtype;
  v_booking_status text;
begin
  if p_workflow is null or length(trim(p_workflow)) = 0 then
    raise exception 'A capture request needs a named backend workflow' using errcode = 'check_violation';
  end if;
  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'Unknown payment' using errcode = 'check_violation';
  end if;
  select booking_status into v_booking_status from public.bookings where id = v_pay.booking_id for update;
  if v_booking_status <> 'verified' or not public.booking_all_tickets_verified(v_pay.booking_id) then
    raise exception 'Capture is requested only after every ticket is independently verified' using errcode = 'check_violation';
  end if;
  if v_pay.status <> 'authorised' then
    raise exception 'Only an authorised payment can be sent for capture' using errcode = 'check_violation';
  end if;

  perform set_config('go.payment_authority', 'capture_request', true);
  update public.payments set status = 'capture_requested', capture_requested_at = now(), updated_at = now()
    where id = p_payment_id;
  perform set_config('go.payment_authority', '', true);

  insert into public.payment_financial_events (payment_id, booking_id, action, from_status, to_status, actor_kind, actor_label, called_as)
  values (p_payment_id, v_pay.booking_id, 'capture_requested', 'authorised', 'capture_requested', 'backend_workflow',
          'backend:' || p_workflow, session_user);
end $$;

-- Step 2: a provider result, verified by webhook signature or by the provider's own status lookup. Only the service role
-- may call it. Outcomes: applied, no_change, review_required, duplicate (a repeated event), rejected (with a reason).
-- Every attempt is recorded in payment_provider_events. A browser redirect or client status is never an input.
create or replace function public.apply_payment_provider_event(
  p_provider           text,
  p_provider_event_id  text,
  p_event_type         text,
  p_provider_reference text,
  p_provider_state     text,
  p_amount_minor       bigint,
  p_currency           char(3),
  p_occurred_at        timestamptz,
  p_verification       text,
  p_payload_sha256     text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pay public.payments%rowtype;
  v_verification text := case when p_verification in ('webhook_signature', 'provider_lookup') then p_verification else 'none' end;
  v_result text;
  v_reason text;
  v_target text;
  v_last timestamptz;
  v_row_id bigint;
  v_actor text := 'provider:' || coalesce(p_provider, 'unknown');
begin
  -- 1. The event must be verified. Anything else is recorded as rejected and changes nothing.
  if v_verification = 'none' then
    v_result := 'rejected'; v_reason := 'event is not verified by signature or provider lookup';
  elsif p_payload_sha256 is null or p_payload_sha256 !~ '^[0-9a-f]{64}$' then
    v_result := 'rejected'; v_reason := 'payload digest is malformed';
  else
    -- 2. The payment reference must match a payment for this provider.
    select * into v_pay from public.payments where provider = p_provider and provider_reference = p_provider_reference for update;
    if not found then
      v_result := 'rejected'; v_reason := 'unknown payment reference';
    -- 3. Replays and duplicates: an event already processed changes nothing.
    elsif exists (select 1 from public.payment_provider_events e
                  where e.provider = p_provider and e.provider_event_id = p_provider_event_id
                    and e.processing_result in ('applied', 'no_change', 'review_required')) then
      v_result := 'duplicate'; v_reason := 'event already processed';
    -- 4. Stale events: an event older than the last processed event for this payment is refused.
    else
      select max(occurred_at) into v_last from public.payment_provider_events
        where payment_id = v_pay.id and processing_result in ('applied', 'no_change', 'review_required');
      if v_last is not null and p_occurred_at < v_last then
        v_result := 'rejected'; v_reason := 'stale event: older than the last processed event for this payment';
      elsif p_event_type = 'settlement' then
        -- 5a. Settlement: recorded once, only for a captured payment.
        if v_pay.status <> 'captured' then
          v_result := 'rejected'; v_reason := 'settlement is recorded only for a captured payment';
        elsif v_pay.provider_settled_at is not null then
          v_result := 'rejected'; v_reason := 'settlement is already recorded';
        elsif p_amount_minor is distinct from v_pay.captured_minor or p_currency is distinct from v_pay.currency then
          v_result := 'review_required'; v_reason := 'settlement amount or currency does not match the captured payment';
        else
          v_result := 'applied'; v_reason := 'provider settlement recorded';
        end if;
      else
        -- 5b. A status event. Map the provider's reported state to a payment state.
        v_target := case p_provider_state
          when 'authorised' then 'authorised'
          when 'captured' then 'captured'
          when 'failed' then 'failed'
          when 'released' then 'released'
          when 'pending' then null
          when 'other' then 'review_required'
          else 'invalid' end;
        if v_target = 'invalid' then
          v_result := 'rejected'; v_reason := 'unknown provider state';
        elsif v_target is null then
          v_result := 'no_change'; v_reason := 'provider reports pending';
        elsif (p_provider_state in ('authorised', 'captured')) and (p_amount_minor is distinct from v_pay.amount_minor or p_currency is distinct from v_pay.currency) then
          v_result := 'review_required'; v_reason := 'provider amount or currency does not match the payment';
          v_target := 'review_required';
        elsif v_pay.status = v_target then
          v_result := 'no_change'; v_reason := 'payment is already in this state';
        elsif v_target = 'review_required' then
          v_result := 'review_required'; v_reason := 'provider reports an unexpected state';
        elsif v_target = 'captured' and v_pay.status <> 'capture_requested' then
          v_result := 'review_required'; v_reason := 'provider reports capture for a payment without a capture request';
          v_target := 'review_required';
        elsif not public.payment_transition_allowed(v_pay.status, v_target) then
          v_result := 'rejected'; v_reason := 'invalid transition from ' || v_pay.status || ' to ' || v_target;
          v_target := null;
        else
          v_result := 'applied'; v_reason := 'provider result applied';
        end if;
      end if;
    end if;
  end if;

  -- Record the attempt first, so every outcome (including rejections) is in the audit trail.
  insert into public.payment_provider_events (
    provider, provider_event_id, event_type, provider_reference, payment_id, provider_state, amount_minor, currency,
    occurred_at, verification, payload_sha256, processing_result, result_reason, actor_label, called_as)
  values (
    coalesce(p_provider, 'unknown'), coalesce(p_provider_event_id, ''), coalesce(p_event_type, ''),
    coalesce(p_provider_reference, ''), case when v_pay.id is null then null else v_pay.id end,
    case when p_provider_state in ('pending', 'authorised', 'captured', 'failed', 'released', 'other') then p_provider_state else null end,
    p_amount_minor, p_currency, p_occurred_at, v_verification,
    coalesce(p_payload_sha256, repeat('0', 64)), v_result, v_reason, v_actor, session_user)
  returning id into v_row_id;

  -- Apply the change only for an applied or review result, in the same transaction as the record above.
  if v_result in ('applied', 'review_required') and v_pay.id is not null then
    if p_event_type = 'settlement' and v_result = 'applied' then
      perform set_config('go.payment_authority', 'provider_event', true);
      update public.payments set provider_settled_at = p_occurred_at, updated_at = now() where id = v_pay.id;
      perform set_config('go.payment_authority', '', true);
      insert into public.payment_financial_events (payment_id, booking_id, action, from_status, to_status, actor_kind, actor_label, provider_event_row, called_as)
      values (v_pay.id, v_pay.booking_id, 'provider_settled', v_pay.status, v_pay.status, 'provider_event', v_actor, v_row_id, session_user);
    elsif p_event_type = 'settlement' then
      null;   -- review only: recorded in payment_provider_events for a person to decide
    else
      -- review_required is written as the target when the payment's transition to it is legal.
      if v_result = 'review_required' then
        v_target := 'review_required';
        if not public.payment_transition_allowed(v_pay.status, v_target) then
          v_target := null;
        end if;
      end if;
      if v_target is not null then
        perform set_config('go.payment_authority', 'provider_event', true);
        update public.payments set status = v_target,
          captured_minor = case when v_target = 'captured' then v_pay.amount_minor else captured_minor end,
          updated_at = now()
        where id = v_pay.id;
        perform set_config('go.payment_authority', '', true);
        insert into public.payment_financial_events (payment_id, booking_id, action, from_status, to_status, actor_kind, actor_label, provider_event_row, called_as)
        values (v_pay.id, v_pay.booking_id, 'status_changed', v_pay.status, v_target, 'provider_event', v_actor, v_row_id, session_user);
      end if;
    end if;
  end if;
  return v_result;
end $$;

revoke execute on function public.payment_transition_allowed(text, text) from public, anon, authenticated;
revoke execute on function public.guard_payment_state() from public, anon, authenticated;
revoke execute on function public.prevent_payment_event_change() from public, anon, authenticated;
revoke execute on function public.request_payment_capture(uuid, text) from public, anon, authenticated;
revoke execute on function public.apply_payment_provider_event(text, text, text, text, text, bigint, char, timestamptz, text, text)
  from public, anon, authenticated;
grant execute on function public.request_payment_capture(uuid, text) to service_role;
grant execute on function public.apply_payment_provider_event(text, text, text, text, text, bigint, char, timestamptz, text, text)
  to service_role;

-- 5. Transition tables (generated from BOOKING_TRANSITIONS and REMITTANCE_TRANSITIONS in packages/core).
create or replace function public.booking_transition_allowed(from_state text, to_state text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select (from_state, to_state) in (
@@TRANSITIONS@@
  )
$$;

create or replace function public.remittance_transition_allowed(from_status text, to_status text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select (from_status, to_status) in (
@@REMITTANCE_TRANSITIONS@@
  )
$$;

create or replace function public.booking_all_tickets_verified(booking uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.passengers p where p.booking_id = booking)
    and not exists (
      select 1 from public.passengers p
      where p.booking_id = booking
        and not exists (select 1 from public.tickets t where t.passenger_id = p.id and t.verified_at is not null)
    )
$$;

-- Every booking change of status goes through this guard. It is the database's answer to "illegal transition".
create or replace function public.guard_booking_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.booking_status <> 'draft' then
      raise exception 'A booking must be created in draft' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.booking_status is distinct from old.booking_status then
    if not public.booking_transition_allowed(old.booking_status, new.booking_status) then
      raise exception 'Illegal booking transition % -> %', old.booking_status, new.booking_status using errcode = 'check_violation';
    end if;
    if new.booking_status = 'verified' and not public.booking_all_tickets_verified(new.id) then
      raise exception 'A booking can be verified only when every passenger has a verified ticket' using errcode = 'check_violation';
    end if;
    if new.booking_status = 'captured' and not exists (
      select 1 from public.payments p where p.booking_id = new.id and p.status = 'captured'
    ) then
      raise exception 'A booking can be captured only when its payment is captured' using errcode = 'check_violation';
    end if;
    -- Confirmation needs GO's verification of every ticket and the customer's capture. Nothing else.
    if new.booking_status = 'confirmed' and not (
      public.booking_all_tickets_verified(new.id)
      and exists (select 1 from public.payments p where p.booking_id = new.id and p.status = 'captured')
    ) then
      raise exception 'A booking can be confirmed only when every ticket is verified and the payment is captured' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

create trigger bookings_state_guard
  before insert or update of booking_status on public.bookings
  for each row execute function public.guard_booking_state();

-- Payment capture needs a verified booking and verified tickets for every passenger (invariant 1 of docs/06).
create or replace function public.guard_payment_capture()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'captured' and (tg_op = 'INSERT' or old.status is distinct from 'captured') then
    if not exists (select 1 from public.bookings b where b.id = new.booking_id and b.booking_status = 'verified') then
      raise exception 'A payment may be captured only for a verified booking' using errcode = 'check_violation';
    end if;
    if not public.booking_all_tickets_verified(new.booking_id) then
      raise exception 'A payment may be captured only when every passenger has a verified ticket' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

create trigger payments_capture_guard
  before insert or update of status on public.payments
  for each row execute function public.guard_payment_capture();

-- Remittance rules (docs/24 section 3A; service rules in packages/core/src/partner-remittance.ts; docs/25 section 8).
--   - Every change needs a signed-in user (auth.uid()) who is finance or an administrator in an MFA session.
--     A change with no authenticated actor, including the service role, is refused.
--   - Only an administrator in an MFA session may record or change a remittance to paid or not_required, or correct its
--     agreement terms.
--   - A not_required record needs approval by the signed-in administrator. Its evidence cannot change afterwards.
--   - Attribution (id, created_at, agreement_recorded_by, agreement_recorded_at) cannot change.
--   - A remittance exists only for a booking with a partner order. It never changes the booking's state.
--   - A paid remittance is final. Recovery from failed or under review is a counted attempt with a note.
-- Security definer, with a pinned search path (docs/25, section 6B).
create or replace function public.guard_partner_remittance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_finance boolean;
  v_admin boolean;
  v_agreement_changed boolean;
  v_recovery boolean;
begin
  if v_actor is null then
    raise exception 'Partner remittance changes need a signed-in user; the service role cannot change them' using errcode = 'check_violation';
  end if;
  v_finance := public.is_finance_mfa();
  v_admin := public.is_admin_mfa();
  if not v_finance then
    raise exception 'Only finance or an administrator in a multi-factor session can change a partner remittance' using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' then
    if not exists (select 1 from public.bookings b where b.id = new.booking_id and b.partner_order_confirmed_at is not null) then
      raise exception 'A partner remittance needs a booking with a partner order' using errcode = 'check_violation';
    end if;
    if new.status not in (@@REMITTANCE_INSERT_STATUSES@@) then
      raise exception 'A remittance cannot be created as %', new.status using errcode = 'check_violation';
    end if;
    if new.status in (@@ADMIN_ONLY_REMITTANCE_STATUSES@@) and not v_admin then
      raise exception 'Only an administrator can record a remittance as %', new.status using errcode = 'check_violation';
    end if;
    if new.agreement_recorded_by is distinct from v_actor then
      raise exception 'The agreement must be recorded by the signed-in user' using errcode = 'check_violation';
    end if;
    if new.status = 'not_required' and new.no_obligation_approved_by is distinct from v_actor then
      raise exception 'A not-required remittance must be approved by the signed-in administrator' using errcode = 'check_violation';
    end if;
    new.attempt_count := case when new.status = 'pending' then 1 else 0 end;
    return new;
  end if;

  if new.id is distinct from old.id or new.created_at is distinct from old.created_at
     or new.agreement_recorded_by is distinct from old.agreement_recorded_by
     or new.agreement_recorded_at is distinct from old.agreement_recorded_at then
    raise exception 'The identity and attribution of a partner remittance cannot change' using errcode = 'check_violation';
  end if;
  if new.booking_id is distinct from old.booking_id then
    raise exception 'A partner remittance cannot move to another booking' using errcode = 'check_violation';
  end if;
  if old.status = 'paid' then
    raise exception 'A paid partner remittance cannot change' using errcode = 'check_violation';
  end if;
  if (new.no_obligation_approved_by, new.no_obligation_approved_at, new.no_obligation_evidence)
     is distinct from (old.no_obligation_approved_by, old.no_obligation_approved_at, old.no_obligation_evidence) then
    raise exception 'No-obligation evidence cannot change once recorded' using errcode = 'check_violation';
  end if;

  v_agreement_changed := (new.agreement_reference, new.agreement_clause, new.amount_minor, new.currency, new.due_at)
    is distinct from (old.agreement_reference, old.agreement_clause, old.amount_minor, old.currency, old.due_at);
  if v_agreement_changed then
    if not v_admin then
      raise exception 'Only an administrator can correct agreement terms on a remittance' using errcode = 'check_violation';
    end if;
    if new.status_reason is null or btrim(new.status_reason) = '' then
      raise exception 'A correction to agreement terms needs a reason' using errcode = 'check_violation';
    end if;
  end if;

  v_recovery := old.status in ('failed', 'under_review') and new.status = 'pending';
  if new.status is distinct from old.status then
    if not public.remittance_transition_allowed(old.status, new.status) then
      raise exception 'Illegal remittance transition % -> %', old.status, new.status using errcode = 'check_violation';
    end if;
    if new.status in (@@ADMIN_ONLY_REMITTANCE_STATUSES@@) and not v_admin then
      raise exception 'Only an administrator can record a remittance as %', new.status using errcode = 'check_violation';
    end if;
    if new.status in ('failed', 'under_review') and (new.status_reason is null or btrim(new.status_reason) = '') then
      raise exception 'A remittance marked % needs a reason', new.status using errcode = 'check_violation';
    end if;
    if v_recovery and (new.status_reason is null or btrim(new.status_reason) = '') then
      raise exception 'A recovery attempt needs a note on what was corrected before it is retried' using errcode = 'check_violation';
    end if;
  end if;

  -- The attempt counter is set here only, never by the caller.
  new.attempt_count := case when v_recovery then old.attempt_count + 1 else old.attempt_count end;
  new.updated_at := now();
  return new;
end $$;

create trigger partner_remittances_guard
  before insert or update on public.partner_remittances
  for each row execute function public.guard_partner_remittance();

create or replace function public.audit_partner_remittance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Every partner remittance change must name its authenticated actor' using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then
    insert into public.partner_remittance_events (remittance_id, booking_id, action, actor, before_state, after_state, reason)
    values (new.id, new.booking_id, 'created', auth.uid(), null, to_jsonb(new), new.status_reason);
  elsif (to_jsonb(old) - 'updated_at') is distinct from (to_jsonb(new) - 'updated_at') then
    insert into public.partner_remittance_events (remittance_id, booking_id, action, actor, before_state, after_state, reason)
    values (new.id, new.booking_id, 'changed', auth.uid(), to_jsonb(old), to_jsonb(new), new.status_reason);
  end if;
  return null;
end $$;

create trigger partner_remittances_audit
  after insert or update on public.partner_remittances
  for each row execute function public.audit_partner_remittance();

create or replace function public.prevent_remittance_event_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Partner remittance events are append-only' using errcode = 'check_violation';
end $$;

create trigger partner_remittance_events_append_only
  before update or delete on public.partner_remittance_events
  for each row execute function public.prevent_remittance_event_change();

-- 6. Security hardening (docs/25, section 7).
-- 6a. Every SECURITY DEFINER function in public names its search_path explicitly, with pg_temp last, so no
--     session-level object can take over an unqualified name inside it.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
  loop
    execute format('alter function %s set search_path = public, pg_temp', f.sig);
  end loop;
end $$;

-- 6b. API roles hold only the privileges their policies need. TRUNCATE, TRIGGER and REFERENCES are not needed by
--     signed-in or anonymous users, and TRUNCATE bypasses row level security.
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;

-- 6c. The audit trail cannot be truncated by anyone, including the table owner.
create trigger partner_remittance_events_no_truncate
  before truncate on public.partner_remittance_events
  for each statement execute function public.prevent_remittance_event_change();

-- Trigger and helper functions are called by the database, not through the API.
revoke execute on function public.guard_currency_bookable() from public, anon, authenticated;
revoke execute on function public.guard_booking_state() from public, anon, authenticated;
revoke execute on function public.guard_payment_capture() from public, anon, authenticated;
revoke execute on function public.guard_partner_remittance() from public, anon, authenticated;
revoke execute on function public.audit_partner_remittance() from public, anon, authenticated;
revoke execute on function public.prevent_remittance_event_change() from public, anon, authenticated;
revoke execute on function public.booking_transition_allowed(text, text) from public, anon, authenticated;
revoke execute on function public.remittance_transition_allowed(text, text) from public, anon, authenticated;
revoke execute on function public.booking_all_tickets_verified(uuid) from public, anon, authenticated;
revoke execute on function public.booking_stage(text) from public, anon;

commit;
