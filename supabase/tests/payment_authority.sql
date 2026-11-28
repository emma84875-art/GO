-- Phase 19.2 payment authority checks. Runs in one transaction and rolls back. Expects every migration applied,
-- including 20261129000000_payment_authority.sql. Each failed check raises an exception.
begin;

create or replace function pg_temp.expect_error(p_sql text, p_expected_state text, p_label text)
returns void
language plpgsql
as $$
begin
  execute p_sql;
  raise exception 'FAILED %: expected an error', p_label;
exception
  when others then
    if sqlstate <> p_expected_state then
      raise exception 'FAILED %: expected sqlstate %, got % (%)', p_label, p_expected_state, sqlstate, sqlerrm;
    end if;
end;
$$;

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000019a1');
insert into public.profiles (id) values ('00000000-0000-0000-0000-0000000019a1') on conflict do nothing;
insert into public.bookings (id, user_id, display_currency, display_amount_minor)
  values ('00000000-0000-0000-0000-0000000019b1', '00000000-0000-0000-0000-0000000019a1', 'NGN', 150000);
insert into public.bookings (id, user_id, display_currency, display_amount_minor)
  values ('00000000-0000-0000-0000-0000000019b2', '00000000-0000-0000-0000-0000000019a1', 'NGN', 150000);
update public.bookings set booking_status = 'quoted', quoted_at = now() where id = '00000000-0000-0000-0000-0000000019b1';

-- A. The write-ahead start creates an initiated row with a placeholder provider reference.
do $$
declare
  v_id uuid;
  v_row jsonb;
begin
  v_id := public.app_payment_start('00000000-0000-0000-0000-0000000019b1', 'fixture', 'booking:b1:payment_start:1',
    150000, 'NGN', now() + interval '30 minutes');
  v_row := public.app_payment_load(v_id);
  if v_row ->> 'status' <> 'initiated' then raise exception 'FAILED A1: a new payment must be initiated'; end if;
  if v_row ->> 'provider_reference' <> 'pending:booking:b1:payment_start:1' then raise exception 'FAILED A2: placeholder reference'; end if;
  if (v_row ->> 'captured_minor')::bigint <> 0 then raise exception 'FAILED A3: nothing captured at start'; end if;
end $$;

-- B. The same reference returns the same payment and creates no second row.
do $$
declare
  v_first uuid;
  v_again uuid;
begin
  v_first := (select id from public.payments where reference = 'booking:b1:payment_start:1');
  v_again := public.app_payment_start('00000000-0000-0000-0000-0000000019b1', 'fixture', 'booking:b1:payment_start:1',
    150000, 'NGN', now() + interval '30 minutes');
  if v_again <> v_first then raise exception 'FAILED B1: a repeat must return the same payment'; end if;
  if (select count(*) from public.payments where reference = 'booking:b1:payment_start:1') <> 1 then
    raise exception 'FAILED B2: a repeat must not create a second row';
  end if;
end $$;

-- C. A reference reused for different details is refused.
select pg_temp.expect_error($sql$
  select public.app_payment_start('00000000-0000-0000-0000-0000000019b1', 'fixture', 'booking:b1:payment_start:1',
    999, 'NGN', now() + interval '30 minutes')
$sql$, '23514', 'C1 reference reused with a different amount');

-- D. A second live payment for the same booking is refused by the 19.1 index.
select pg_temp.expect_error($sql$
  select public.app_payment_start('00000000-0000-0000-0000-0000000019b1', 'fixture', 'booking:b1:other:1',
    150000, 'NGN', now() + interval '30 minutes')
$sql$, '23505', 'D1 second live payment for one booking');

-- E. A payment cannot start for a booking that is not quoted.
select pg_temp.expect_error($sql$
  select public.app_payment_start('00000000-0000-0000-0000-0000000019b2', 'fixture', 'booking:b2:payment_start:1',
    150000, 'NGN', now() + interval '30 minutes')
$sql$, '23514', 'E1 booking not quoted');

-- F. An unknown booking is refused.
select pg_temp.expect_error($sql$
  select public.app_payment_start('00000000-0000-0000-0000-00000000dead', 'fixture', 'booking:dead:payment_start:1',
    150000, 'NGN', now() + interval '30 minutes')
$sql$, '23514', 'F1 unknown booking');

-- G. The provider reference is bound once. The same value is a no-op; a different value is refused.
do $$
declare
  v_id uuid := (select id from public.payments where reference = 'booking:b1:payment_start:1');
begin
  perform public.app_payment_bind_reference(v_id, 'fx_provider_1');
  perform public.app_payment_bind_reference(v_id, 'fx_provider_1');
  if (select provider_reference from public.payments where id = v_id) <> 'fx_provider_1' then
    raise exception 'FAILED G1: the bound reference must be stored';
  end if;
end $$;

select pg_temp.expect_error($sql$
  select public.app_payment_bind_reference((select id from public.payments where reference = 'booking:b1:payment_start:1'), 'fx_other')
$sql$, '23514', 'G2 different provider reference');

-- H. Once the 19.1 provider path authorises the payment, the start function and bind refuse to change it.
select public.apply_payment_provider_event('fixture', 'evt-auth-1', 'authorised', 'fx_provider_1', 'authorised',
  150000, 'NGN', now(), 'webhook_signature', repeat('a', 64));
do $$
begin
  if (select status from public.payments where reference = 'booking:b1:payment_start:1') <> 'authorised' then
    raise exception 'FAILED H1: the 19.1 provider path must authorise the payment';
  end if;
end $$;

select pg_temp.expect_error($sql$
  select public.app_payment_bind_reference((select id from public.payments where reference = 'booking:b1:payment_start:1'), 'fx_provider_2')
$sql$, '23514', 'H2 bind after authorisation');

-- I. Reads return the stored row, and an unknown reference or id returns null.
do $$
begin
  if public.app_payment_find_by_reference('booking:b1:payment_start:1') ->> 'status' <> 'authorised' then
    raise exception 'FAILED I1: find by reference returns the stored status';
  end if;
  if public.app_payment_find_by_reference('booking:nothing:1') is not null then
    raise exception 'FAILED I2: an unknown reference returns null';
  end if;
  if public.app_payment_load('00000000-0000-0000-0000-00000000dead') is not null then
    raise exception 'FAILED I3: an unknown payment returns null';
  end if;
end $$;

-- J. Signed-in and anonymous roles cannot execute the functions.
do $$
begin
  set local role authenticated;
  begin
    perform public.app_payment_start('00000000-0000-0000-0000-0000000019b2', 'fixture', 'x', 1, 'NGN', now());
    raise exception 'FAILED J1: authenticated must not start a payment';
  exception when insufficient_privilege then
    null;
  end;
  reset role;
end $$;

do $$
begin
  set local role anon;
  begin
    perform public.app_payment_find_by_reference('x');
    raise exception 'FAILED J2: anon must not read a payment';
  exception when insufficient_privilege then
    null;
  end;
  reset role;
end $$;

select 'payment authority checks passed' as result;

rollback;
