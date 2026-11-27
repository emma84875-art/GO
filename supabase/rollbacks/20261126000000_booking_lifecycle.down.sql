-- Rollback for supabase/migrations/20261126000000_booking_lifecycle.sql (Phase 19.1).
-- Not applied automatically. Run by hand, or by scripts/test-db.sh for the round-trip check.
--
-- It refuses to run, and changes nothing, if any row holds information the legacy model cannot represent:
--   - a booking in a state with no legacy equivalent (only draft, quoted and failed can be restored);
--   - any milestone timestamp, ticketing partner, status reason or ticket verification;
--   - any partner remittance record (the legacy model has no place for it);
--   - any provider settlement;
--   - a currency outside the four codes the legacy checks allowed;
--   - a finance role, or a staff MFA reset for a finance account, or any payment financial event (capture or
--     provider-settlement audit record), which the legacy model has no place for.

begin;

do $$
declare
  n bigint;
begin
  select count(*) into n from public.bookings where booking_status not in ('draft', 'quoted', 'failed');
  if n > 0 then
    raise exception 'Rollback stopped: % booking(s) are in a state the legacy model cannot represent. Nothing was changed.', n;
  end if;

  select count(*) into n from public.bookings
  where quoted_at is not null or authorised_at is not null or partner_order_confirmed_at is not null
     or tickets_issued_at is not null or tickets_verified_at is not null or captured_at is not null
     or confirmed_at is not null or ticketing_partner is not null or status_reason is not null;
  if n > 0 then
    raise exception 'Rollback stopped: % booking(s) hold milestone or partner data the legacy model cannot keep. Nothing was changed.', n;
  end if;

  select count(*) into n from public.partner_remittances;
  if n > 0 then
    raise exception 'Rollback stopped: % partner remittance record(s) exist, which the legacy model cannot keep. Nothing was changed.', n;
  end if;

  select count(*) into n from public.profiles where role = 'finance';
  if n > 0 then
    raise exception 'Rollback stopped: % finance account(s) exist, which the legacy role list cannot keep. Nothing was changed.', n;
  end if;

  select count(*) into n from public.staff_mfa_resets where target_role = 'finance';
  if n > 0 then
    raise exception 'Rollback stopped: % staff MFA reset(s) target a finance account. Nothing was changed.', n;
  end if;

  select count(*) into n from public.payment_financial_events;
  if n > 0 then
    raise exception 'Rollback stopped: % payment financial event(s) exist, which the legacy model cannot keep. Nothing was changed.', n;
  end if;

  select count(*) into n from public.payments where provider_settled_at is not null;
  if n > 0 then
    raise exception 'Rollback stopped: % payment(s) hold a provider settlement the legacy model cannot keep. Nothing was changed.', n;
  end if;

  select count(*) into n from public.payment_provider_events;
  if n > 0 then
    raise exception 'Rollback stopped: % payment provider event record(s) exist, which the legacy model cannot keep. Nothing was changed.', n;
  end if;

  select count(*) into n from public.payments where status = 'capture_requested';
  if n > 0 then
    raise exception 'Rollback stopped: % payment(s) await a capture result, a state the legacy model does not have. Nothing was changed.', n;
  end if;

  select count(*) into n from public.tickets where verified_at is not null;
  if n > 0 then
    raise exception 'Rollback stopped: % ticket(s) hold a verification the legacy model cannot keep. Nothing was changed.', n;
  end if;

  select count(*) into n from public.bookings where display_currency not in ('NGN', 'USD', 'GBP', 'EUR')
     or supplier_currency not in ('NGN', 'USD', 'GBP', 'EUR');
  if n > 0 then
    raise exception 'Rollback stopped: % booking(s) use a currency the legacy checks do not allow. Nothing was changed.', n;
  end if;
  select count(*) into n from public.payments where currency not in ('NGN', 'USD', 'GBP', 'EUR');
  if n > 0 then
    raise exception 'Rollback stopped: % payment(s) use a currency the legacy checks do not allow. Nothing was changed.', n;
  end if;
  select count(*) into n from public.searches where display_currency not in ('NGN', 'USD', 'GBP', 'EUR');
  if n > 0 then
    raise exception 'Rollback stopped: % search(es) use a currency the legacy checks do not allow. Nothing was changed.', n;
  end if;
end $$;

-- Finance role objects (added by 19.1). The tables are dropped first, so their policies go with them. Their rows were
-- refused above, so the audit trails are dropped only when they are empty.
-- Payments first: the trigger depends on the function below. Signed-in write revocations stay in place (tighter than the
-- legacy grants, which are not restored here); nothing a signed-in user could do before 19.1 is granted back.
drop trigger if exists payments_state_guard on public.payments;
drop policy if exists payments_finance_select on public.payments;
drop function if exists public.request_payment_capture(uuid, text);
drop function if exists public.apply_payment_provider_event(text, text, text, text, text, bigint, char, timestamptz, text, text);
drop table if exists public.payment_financial_events;
drop table if exists public.payment_provider_events;

drop table if exists public.partner_remittance_events;
drop table if exists public.partner_remittances;
drop table if exists public.payment_financial_events;
drop function if exists public.audit_partner_remittance();
drop function if exists public.prevent_remittance_event_change();
drop function if exists public.guard_partner_remittance();
drop function if exists public.remittance_transition_allowed(text, text);
drop function if exists public.guard_payment_state();
drop function if exists public.prevent_payment_event_change();
drop function if exists public.payment_transition_allowed(text, text);
drop function if exists public.is_finance_mfa();


-- Restore the phase 14 and phase 15 function bodies (their role lists had no finance). The hardened search_path
-- from 19.1 is kept: it removes a search_path hijack risk and changes no behaviour.
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

alter table public.staff_mfa_resets drop constraint if exists staff_mfa_resets_target_role_check;
alter table public.staff_mfa_resets
  add constraint staff_mfa_resets_target_role_check check (target_role in ('support', 'operations', 'admin'));

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('customer', 'support', 'operations', 'admin'));

-- Triggers and functions added by 19.1.
drop trigger if exists bookings_state_guard on public.bookings;
drop trigger if exists payments_capture_guard on public.payments;
drop trigger if exists bookings_currency_bookable on public.bookings;
drop trigger if exists payments_currency_bookable on public.payments;
drop trigger if exists searches_currency_bookable on public.searches;

-- Restore the legacy reservation and ticket columns from booking_status.
alter table public.bookings
  add column reservation_status text not null default 'draft'
    constraint bookings_reservation_status_check check (reservation_status in (
      'draft', 'quoted', 'pending_payment', 'payment_confirmed',
      'reservation_pending', 'reservation_confirmed', 'reservation_failed')),
  add column ticket_status text not null default 'not_issued'
    constraint bookings_ticket_status_check check (ticket_status in (
      'not_issued', 'ticketing_pending', 'ticketed', 'ticketing_failed'));

update public.bookings set reservation_status = case booking_status
  when 'draft' then 'draft'
  when 'quoted' then 'quoted'
  when 'failed' then 'reservation_failed'
end;

alter table public.bookings
  add constraint ticketed_requires_confirmed_reservation check (
    ticket_status <> 'ticketed' or reservation_status = 'reservation_confirmed'),
  add constraint ticketing_requires_confirmed_reservation check (
    ticket_status not in ('ticketing_pending', 'ticketed') or reservation_status = 'reservation_confirmed');

-- Replace the 19.1 ticket policy first: it reads bookings.booking_status and tickets.verified_at.
-- Restore the phase 14 ticket policy: the booking owner or staff with MFA, with no verification rule.
drop policy if exists tickets_select on public.tickets;
create policy tickets_select on public.tickets for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id
    and (b.user_id = auth.uid() or public.is_staff_mfa())));

alter table public.tickets drop column verified_at;

-- Remove the 19.1 columns and constraints.
alter table public.bookings drop constraint if exists booking_milestones_consistent;
alter table public.bookings drop constraint if exists bookings_booking_status_check;
alter table public.bookings
  drop column booking_status,
  drop column quoted_at,
  drop column authorised_at,
  drop column partner_order_confirmed_at,
  drop column tickets_issued_at,
  drop column tickets_verified_at,
  drop column captured_at,
  drop column confirmed_at,
  drop column ticketing_partner,
  drop column funding_model,
  drop column status_reason;

alter table public.payments drop constraint if exists payments_provider_settled_after_capture;
alter table public.payments drop column if exists provider_settled_at;

-- The 19.1 payment states and controls: restore the legacy status list (capture_requested was refused above), the
-- legacy processed-event column, and remove the capture request time.
alter table public.payments drop constraint if exists payments_capture_request_time;
alter table public.payments drop column if exists capture_requested_at;
alter table public.payments drop constraint if exists payments_status_check;
alter table public.payments add constraint payments_status_check check (status in (
  'initiated', 'authorised', 'captured', 'failed', 'expired', 'released',
  'refund_pending', 'refunded', 'review_required'));
alter table public.payments add column if not exists processed_event_ids text[] not null default '{}';

-- Restore the legacy currency checks and remove the reference table.
alter table public.searches drop constraint if exists searches_display_currency_fkey;
alter table public.searches add constraint searches_display_currency_check check (display_currency in ('NGN', 'USD', 'GBP', 'EUR'));

alter table public.bookings drop constraint if exists bookings_display_currency_fkey;
alter table public.bookings drop constraint if exists bookings_supplier_currency_fkey;
alter table public.bookings
  add constraint bookings_display_currency_check check (display_currency in ('NGN', 'USD', 'GBP', 'EUR')),
  add constraint bookings_supplier_currency_check check (supplier_currency in ('NGN', 'USD', 'GBP', 'EUR'));

alter table public.payments drop constraint if exists payments_currency_fkey;
alter table public.payments add constraint payments_currency_check check (currency in ('NGN', 'USD', 'GBP', 'EUR'));

drop table public.currency_codes;

drop function if exists public.guard_currency_bookable();
drop function if exists public.guard_booking_state();
drop function if exists public.guard_payment_capture();
drop function if exists public.booking_transition_allowed(text, text);
drop function if exists public.booking_all_tickets_verified(uuid);
drop function if exists public.booking_stage(text);

commit;
