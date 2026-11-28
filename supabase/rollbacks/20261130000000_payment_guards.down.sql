-- Rollback for supabase/migrations/20261130000000_payment_guards.sql (Phase 19.2 review fixes).
-- Restores the previous live index and the bind function from 20261129000000_payment_authority.sql, removes the guards
-- and restores the service role's TRUNCATE privilege. Refused, with no change, if the index predicate cannot be restored
-- because the data conflicts with it.
begin;

drop trigger if exists bookings_delete_guard on public.bookings;
drop function if exists public.guard_booking_delete();
drop trigger if exists payments_delete_guard on public.payments;
drop function if exists public.guard_payment_delete();
grant truncate on public.payments, public.bookings to service_role;

drop trigger if exists bookings_price_guard on public.bookings;
drop function if exists public.guard_booking_price();
drop trigger if exists payments_immutable_guard on public.payments;
drop function if exists public.guard_payment_immutable();

drop index if exists public.payments_one_live_per_booking;
create unique index payments_one_live_per_booking on public.payments (booking_id)
  where status in ('initiated', 'authorised', 'captured', 'refund_pending', 'review_required');

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
  update public.payments set provider_reference = p_provider_reference, updated_at = now() where id = p_payment_id;
end $$;

commit;
