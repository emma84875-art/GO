-- Phase 19.2: payment authority. The Phase 19.1 payments table (public.payments) is the single authoritative record of a
-- payment. This migration adds the functions the application uses to write a payment before the provider is called
-- (write-ahead), to record the provider's reference afterwards, and to read a payment back. Every other change goes
-- through the 19.1 functions: apply_payment_provider_event for provider results, request_payment_capture for capture.
-- Decision record: docs/26.
--
-- Safety properties:
--   1. The start function creates an 'initiated' row only, and only for a booking whose status is 'quoted'. The 19.1
--      guard refuses any other insert status. The one-live-payment-per-booking index and the unique reference both still apply.
--   2. The start is idempotent on the reference: the same reference returns the same payment, and a reference reused
--      for a different booking, provider, amount or currency is refused. A repeat never creates a second payment.
--   3. The provider reference is bound once. The first bound value is final; the same value is a no-op; a different value is refused.
--   4. Only the service role may execute these functions. Signed-in users and anonymous callers cannot.
--   5. Nothing here changes a payment status. Status changes stay with the 19.1 guard and its two functions.

begin;

-- 1. Write-ahead start. Returns the payment id. The provider reference is a placeholder until the provider answers,
--    so it cannot collide with a real provider reference.
create or replace function public.app_payment_start(
  p_booking_id   uuid,
  p_provider     text,
  p_reference    text,
  p_amount_minor bigint,
  p_currency     char(3),
  p_expires_at   timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.payments%rowtype;
  v_status   text;
  v_id       uuid;
begin
  if p_reference is null or length(btrim(p_reference)) = 0 or length(p_reference) > 200 then
    raise exception 'A payment needs a reference of 1 to 200 characters' using errcode = 'check_violation';
  end if;

  select * into v_existing from public.payments where reference = p_reference for update;
  if found then
    if v_existing.booking_id is distinct from p_booking_id
       or v_existing.provider is distinct from p_provider
       or v_existing.amount_minor is distinct from p_amount_minor
       or v_existing.currency is distinct from p_currency then
      raise exception 'The payment reference is already used for different details' using errcode = 'check_violation';
    end if;
    return v_existing.id;
  end if;

  select booking_status into v_status from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception 'Unknown booking' using errcode = 'check_violation';
  end if;
  if v_status <> 'quoted' then
    raise exception 'A payment can start only for a quoted booking' using errcode = 'check_violation';
  end if;

  insert into public.payments (booking_id, provider, provider_reference, reference, amount_minor, currency, status, expires_at)
  values (p_booking_id, p_provider, 'pending:' || p_reference, p_reference, p_amount_minor, p_currency, 'initiated', p_expires_at)
  returning id into v_id;
  return v_id;
end $$;

-- 2. Bind the provider's reference once the provider has answered. Idempotent for the same value.
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

-- 3. Read one payment. Returns null when there is none.
create or replace function public.app_payment_load(p_payment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', id, 'booking_id', booking_id, 'provider', provider, 'provider_reference', provider_reference,
    'reference', reference, 'amount_minor', amount_minor, 'currency', currency, 'status', status,
    'captured_minor', captured_minor, 'refunded_minor', refunded_minor, 'expires_at', expires_at)
  from public.payments where id = p_payment_id;
$$;

-- 4. Find one payment by its idempotency reference. Returns null when there is none.
create or replace function public.app_payment_find_by_reference(p_reference text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', id, 'booking_id', booking_id, 'provider', provider, 'provider_reference', provider_reference,
    'reference', reference, 'amount_minor', amount_minor, 'currency', currency, 'status', status,
    'captured_minor', captured_minor, 'refunded_minor', refunded_minor, 'expires_at', expires_at)
  from public.payments where reference = p_reference;
$$;

revoke all on function public.app_payment_start(uuid, text, text, bigint, char, timestamptz) from public, anon, authenticated;
revoke all on function public.app_payment_bind_reference(uuid, text) from public, anon, authenticated;
revoke all on function public.app_payment_load(uuid) from public, anon, authenticated;
revoke all on function public.app_payment_find_by_reference(text) from public, anon, authenticated;
grant execute on function public.app_payment_start(uuid, text, text, bigint, char, timestamptz) to service_role;
grant execute on function public.app_payment_bind_reference(uuid, text) to service_role;
grant execute on function public.app_payment_load(uuid) to service_role;
grant execute on function public.app_payment_find_by_reference(text) to service_role;

commit;
