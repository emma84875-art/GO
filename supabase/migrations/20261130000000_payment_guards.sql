-- Phase 19.2 review fixes: the live-payment index and unguarded changes to sensitive fields. Decision record: docs/26.
--
-- 1. The one-live-payment index must match LIVE_STATUSES in packages/payments/src/state.ts. The 19.1 index left out
--    capture_requested, so a booking could hold a capture_requested payment and a second live payment at once.
-- 2. The amount, currency, booking, provider and reference of a payment never change after it is created. The provider
--    reference is set once, by app_payment_bind_reference, while the payment is initiated. A refunded amount changes
--    only from a verified provider event. These rules apply to the service role and to every backend authority. The 19.1
--    status guard does not check these columns, so they needed their own trigger.
-- 3. The price and currency of a booking are fixed once it leaves draft. A price change after quoting would desynchronise
--    the booking from its payment.
--
-- Safety: this migration only adds rules. Existing rows must already satisfy the index. If they do not, the migration
-- fails and changes nothing.

begin;

-- 1. The live index, matching LIVE_STATUSES exactly.
drop index if exists public.payments_one_live_per_booking;
create unique index payments_one_live_per_booking on public.payments (booking_id)
  where status in ('initiated', 'authorised', 'capture_requested', 'captured', 'refund_pending', 'review_required');

-- 2. Immutable payment fields. Runs for every update, whatever the role or authority.
create or replace function public.guard_payment_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_authority text := nullif(current_setting('go.payment_authority', true), '');
begin
  if new.booking_id is distinct from old.booking_id
     or new.provider is distinct from old.provider
     or new.reference is distinct from old.reference
     or new.amount_minor is distinct from old.amount_minor
     or new.currency is distinct from old.currency then
    raise exception 'A payment''s booking, provider, reference, amount and currency cannot change'
      using errcode = 'check_violation';
  end if;

  if new.provider_reference is distinct from old.provider_reference then
    -- Only app_payment_bind_reference sets the authority to 'bind', and only for an initiated payment that still holds
    -- its placeholder reference.
    if v_authority is distinct from 'bind'
       or old.status <> 'initiated'
       or old.provider_reference <> ('pending:' || old.reference) then
      raise exception 'The provider reference is set once, by the payment start, and cannot change'
        using errcode = 'check_violation';
    end if;
  end if;

  -- A refund is recorded only from a verified provider event. Refunds are not yet built, so no other writer exists.
  if new.refunded_minor is distinct from old.refunded_minor and v_authority is distinct from 'provider_event' then
    raise exception 'A refund is recorded only from a verified provider event'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger payments_immutable_guard
  before update on public.payments
  for each row execute function public.guard_payment_immutable();

-- The bind function sets the authority for its one update. Its body is otherwise the same as in
-- 20261129000000_payment_authority.sql.
create or replace function public.app_payment_bind_reference(p_payment_id uuid, p_provider_reference text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pay public.payments%rowtype;
begin
  if p_provider_reference is null or length(btrim(p_provider_reference)) = 0 or length(p_provider_reference) > 200 then
    raise exception 'A provider reference needs 1 to 200 characters' using errcode = 'check_violation';
  end if;
  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'Unknown payment' using errcode = 'check_violation';
  end if;
  if v_pay.status <> 'initiated' then
    raise exception 'Only an initiated payment takes a provider reference' using errcode = 'check_violation';
  end if;
  if v_pay.provider_reference = p_provider_reference then
    return;
  end if;
  if v_pay.provider_reference <> 'pending:' || v_pay.reference then
    raise exception 'The provider reference is already bound to a different value' using errcode = 'check_violation';
  end if;
  perform set_config('go.payment_authority', 'bind', true);
  update public.payments set provider_reference = p_provider_reference, updated_at = now() where id = p_payment_id;
  perform set_config('go.payment_authority', '', true);
end $$;

-- 3. A booking's price and currency are fixed once it leaves draft.
create or replace function public.guard_booking_price()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.booking_status <> 'draft'
     and (new.display_amount_minor is distinct from old.display_amount_minor
          or new.display_currency is distinct from old.display_currency) then
    raise exception 'The price of a booking cannot change once it has left draft'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger bookings_price_guard
  before update on public.bookings
  for each row execute function public.guard_booking_price();

-- 4. Deletes and truncation. A payment record is never deleted, because it is the financial record and the one live
--    payment per booking depends on it. A booking is deleted only while it is a draft. The service role may not truncate
--    either table; the owner of the database still can.
create or replace function public.guard_payment_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'A payment record cannot be deleted' using errcode = 'check_violation';
end $$;

create trigger payments_delete_guard
  before delete on public.payments
  for each row execute function public.guard_payment_delete();

create or replace function public.guard_booking_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.booking_status <> 'draft' then
    raise exception 'Only a draft booking can be deleted' using errcode = 'check_violation';
  end if;
  return old;
end $$;

create trigger bookings_delete_guard
  before delete on public.bookings
  for each row execute function public.guard_booking_delete();

revoke truncate on public.payments, public.bookings from service_role;

revoke execute on function public.guard_payment_immutable() from public, anon, authenticated;
revoke execute on function public.guard_booking_price() from public, anon, authenticated;
revoke execute on function public.guard_payment_delete() from public, anon, authenticated;
revoke execute on function public.guard_booking_delete() from public, anon, authenticated;

commit;
