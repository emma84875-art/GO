-- Phase 19.2 regression checks: the live-payment index, and the guards on sensitive fields.
-- Runs in one transaction and rolls back. Each failure raises an exception. Expects every migration applied, including
-- 20261130000000_payment_guards.sql. Test rows use the ids 00000000-0000-0000-0000-0000000019e1 to 00000000-0000-0000-0000-0000000019ef.
begin;

-- Passes when the statement fails with the given SQLSTATE. Any other error, or no error, fails the check.
create or replace function pg_temp.expect_error(p_sql text, p_state text, p_label text)
returns void
language plpgsql
as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_state then
      return;
    end if;
    raise exception 'FAILED %: expected SQLSTATE %, got % (%)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAILED %: expected an error, but the statement succeeded', p_label;
end $$;

-- Passes only when the statement is refused with a message containing the fragment. Used where two guards could refuse
-- the same statement, so the check shows which rule refused it.
create or replace function pg_temp.expect_refused(p_sql text, p_fragment text, p_label text)
returns void
language plpgsql
as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm like '%' || p_fragment || '%' then
      return;
    end if;
    raise exception 'FAILED %: refused for the wrong reason (%)', p_label, sqlerrm;
  end;
  raise exception 'FAILED %: expected a refusal, but the statement succeeded', p_label;
end $$;

-- A signed-in customer and a quoted booking. Created as the test owner, before the role changes.
create or replace function pg_temp.new_quoted_booking(p_id uuid, p_user uuid)
returns void
language plpgsql
as $$
begin
  insert into auth.users (id) values (p_user);
  insert into public.profiles (id) values (p_user) on conflict do nothing;
  insert into public.bookings (id, user_id, display_currency, display_amount_minor)
    values (p_id, p_user, 'NGN', 150000);
  update public.bookings set booking_status = 'quoted', quoted_at = now() where id = p_id;
end $$;

-- Part A. The live index must match LIVE_STATUSES in packages/payments/src/state.ts. Every live status blocks a second
-- live payment for its booking; every non-live status does not. Rows are placed with triggers off, because a
-- capture_requested row needs a fully verified booking. The index is what is under test here.
do $$
declare
  live text[] := array['initiated', 'authorised', 'capture_requested', 'captured', 'refund_pending', 'review_required'];
  dead text[] := array['failed', 'expired', 'released', 'refunded'];
  s text;
  bk uuid;
begin
  foreach s in array live loop
    bk := gen_random_uuid();
    perform pg_temp.new_quoted_booking(bk, gen_random_uuid());
    perform set_config('session_replication_role', 'replica', true);
    insert into public.payments (booking_id, provider, provider_reference, reference, amount_minor, currency, status, expires_at,
                                 captured_minor, capture_requested_at)
      values (bk, 'fixture', 'ref-live-' || s, 'ref-live-' || s, 150000, 'NGN', s, now() + interval '1 hour',
              case when s = 'captured' then 150000 else 0 end,
              case when s = 'capture_requested' then now() else null end);
    perform set_config('session_replication_role', 'origin', true);
    begin
      insert into public.payments (booking_id, provider, provider_reference, reference, amount_minor, currency, status, expires_at)
        values (bk, 'fixture', 'pending:ref-second-' || s, 'ref-second-' || s, 150000, 'NGN', 'initiated', now() + interval '1 hour');
      raise exception 'FAILED A-live: a second live payment was allowed while the first is %', s;
    exception when unique_violation then
      null;
    end;
  end loop;

  foreach s in array dead loop
    bk := gen_random_uuid();
    perform pg_temp.new_quoted_booking(bk, gen_random_uuid());
    perform set_config('session_replication_role', 'replica', true);
    insert into public.payments (booking_id, provider, provider_reference, reference, amount_minor, currency, status, expires_at, captured_minor)
      values (bk, 'fixture', 'ref-dead-' || s, 'ref-dead-' || s, 150000, 'NGN', s, now() + interval '1 hour', 0);
    perform set_config('session_replication_role', 'origin', true);
    begin
      insert into public.payments (booking_id, provider, provider_reference, reference, amount_minor, currency, status, expires_at)
        values (bk, 'fixture', 'pending:ref-second-' || s, 'ref-second-' || s, 150000, 'NGN', 'initiated', now() + interval '1 hour');
    exception when unique_violation then
      raise exception 'FAILED A-dead: a non-live % payment blocked a new payment', s;
    end;
  end loop;
end $$;

-- Part B. Rows for the guard checks, created as the test owner.
do $$
declare
  owner_id uuid := '00000000-0000-0000-0000-0000000019e1';
  bk uuid := '00000000-0000-0000-0000-0000000019e2';
  other_bk uuid := '00000000-0000-0000-0000-0000000019e3';
  draft_bk uuid := '00000000-0000-0000-0000-0000000019e4';
  third_bk uuid := '00000000-0000-0000-0000-0000000019e8';
begin
  perform pg_temp.new_quoted_booking(bk, owner_id);
  perform pg_temp.new_quoted_booking(other_bk, gen_random_uuid());
  perform pg_temp.new_quoted_booking(third_bk, gen_random_uuid());
  insert into public.bookings (id, user_id, display_currency, display_amount_minor)
    values (draft_bk, owner_id, 'NGN', 150000);
  insert into public.payments (id, booking_id, provider, provider_reference, reference, amount_minor, currency, status, expires_at)
    values ('00000000-0000-0000-0000-0000000019e5', bk, 'fixture', 'pending:ref-guard-1', 'ref-guard-1', 150000, 'NGN', 'initiated', now() + interval '1 hour');
  insert into public.payments (id, booking_id, provider, provider_reference, reference, amount_minor, currency, status, expires_at)
    values ('00000000-0000-0000-0000-0000000019e6', third_bk, 'fixture', 'pending:ref-guard-2', 'ref-guard-2', 150000, 'NGN', 'initiated', now() + interval '1 hour');
end $$;

-- Part C. Unguarded updates by the service role, the role the application uses. Each must be refused with
-- check_violation (SQLSTATE 23514). A refusal by a missing grant would not count, so the state is checked.
set role service_role;

-- Sensitive payment fields, on the initiated payment 0000000019e5.
select pg_temp.expect_error(
  $$update public.payments set amount_minor = 1 where id = '00000000-0000-0000-0000-0000000019e5'$$, '23514', 'C1 amount_minor is immutable');
select pg_temp.expect_error(
  $$update public.payments set currency = 'USD' where id = '00000000-0000-0000-0000-0000000019e5'$$, '23514', 'C2 currency is immutable');
select pg_temp.expect_error(
  $$update public.payments set booking_id = '00000000-0000-0000-0000-0000000019e3' where id = '00000000-0000-0000-0000-0000000019e5'$$, '23514', 'C3 booking_id is immutable');
select pg_temp.expect_error(
  $$update public.payments set reference = 'ref-tampered' where id = '00000000-0000-0000-0000-0000000019e5'$$, '23514', 'C4 reference is immutable');
select pg_temp.expect_error(
  $$update public.payments set provider_reference = 'fx-direct' where id = '00000000-0000-0000-0000-0000000019e5'$$, '23514',
  'C5 provider_reference cannot be set outside the bind function');

-- Amount change with a backend authority set. The authority allows status changes only, never the amount.
select set_config('go.payment_authority', 'provider_event', true);
select pg_temp.expect_error(
  $$update public.payments set amount_minor = 1 where id = '00000000-0000-0000-0000-0000000019e5'$$, '23514',
  'C6 amount_minor is immutable even under a provider authority');
select set_config('go.payment_authority', '', true);

-- Status and settlement changes without an authority (existing 19.1 guard, kept as a regression check).
select pg_temp.expect_error(
  $$update public.payments set status = 'captured', captured_minor = 150000 where id = '00000000-0000-0000-0000-0000000019e6'$$, '23514',
  'C7 status cannot change without a backend authority');
select pg_temp.expect_error(
  $$update public.payments set captured_minor = 5 where id = '00000000-0000-0000-0000-0000000019e6'$$, '23514',
  'C8 captured_minor cannot change without a backend authority');

-- A refund is recorded only from a verified provider event. The refund guard runs before the amount constraint, so the
-- refusal must name the refund rule.
select pg_temp.expect_refused(
  $$update public.payments set refunded_minor = 1 where id = '00000000-0000-0000-0000-0000000019e5'$$,
  'A refund is recorded only from a verified provider event', 'C11 refunded_minor needs a verified provider event');

-- Price on bookings. Once a booking has left draft, its display amount and currency are fixed.
select pg_temp.expect_error(
  $$update public.bookings set display_amount_minor = 1 where id = '00000000-0000-0000-0000-0000000019e2'$$, '23514',
  'C9 a quoted booking price cannot change');
select pg_temp.expect_error(
  $$update public.bookings set display_currency = 'GBP' where id = '00000000-0000-0000-0000-0000000019e2'$$, '23514',
  'C10 a quoted booking currency cannot change');

-- Part D. Allowed changes still work.
-- D1: a draft booking's price can still be set.
update public.bookings set display_amount_minor = 160000 where id = '00000000-0000-0000-0000-0000000019e4';
do $$
begin
  if (select display_amount_minor from public.bookings where id = '00000000-0000-0000-0000-0000000019e4') <> 160000 then
    raise exception 'FAILED D1: a draft booking price could not be set';
  end if;
end $$;

-- D2: the bind function sets the provider reference once. A second, different value is refused.
select public.app_payment_bind_reference('00000000-0000-0000-0000-0000000019e5', 'fx-bound-1');
do $$
begin
  if (select provider_reference from public.payments where id = '00000000-0000-0000-0000-0000000019e5') <> 'fx-bound-1' then
    raise exception 'FAILED D2: the bind function did not record the provider reference';
  end if;
end $$;
select pg_temp.expect_error(
  $$select public.app_payment_bind_reference('00000000-0000-0000-0000-0000000019e5', 'fx-bound-2')$$, '23514',
  'D2b a bound provider reference cannot change');

-- D3: a provider authority can still move an initiated payment to authorised, and the amount stays the same.
select set_config('go.payment_authority', 'provider_event', true);
update public.payments set status = 'authorised' where id = '00000000-0000-0000-0000-0000000019e5';
select set_config('go.payment_authority', '', true);
do $$
begin
  if (select status || ':' || amount_minor from public.payments where id = '00000000-0000-0000-0000-0000000019e5') <> 'authorised:150000' then
    raise exception 'FAILED D3: the authorised transition did not keep the amount';
  end if;
end $$;

-- Part E. Deletes and truncation. A payment is never deleted. A booking is deleted only as a draft. TRUNCATE is refused
-- to the service role (SQLSTATE 42501, insufficient privilege).
select pg_temp.expect_refused(
  $$delete from public.payments where id = '00000000-0000-0000-0000-0000000019e5'$$,
  'A payment record cannot be deleted', 'E1 a payment cannot be deleted');
select pg_temp.expect_refused(
  $$delete from public.bookings where id = '00000000-0000-0000-0000-0000000019e3'$$,
  'Only a draft booking can be deleted', 'E2 a quoted booking cannot be deleted');
select pg_temp.expect_error($$truncate public.payments$$, '42501', 'E3 the service role cannot truncate payments');
select pg_temp.expect_error($$truncate public.bookings$$, '42501', 'E4 the service role cannot truncate bookings');

-- E5: a draft booking with no payment can still be deleted.
delete from public.bookings where id = '00000000-0000-0000-0000-0000000019e4';
do $$
begin
  if exists (select 1 from public.bookings where id = '00000000-0000-0000-0000-0000000019e4') then
    raise exception 'FAILED E5: a draft booking could not be deleted';
  end if;
end $$;

reset role;
rollback;
