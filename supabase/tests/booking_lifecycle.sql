-- Phase 19.1 database checks: the booking lifecycle, milestones, funding model, verification and capture gates,
-- and ISO 4217 currency handling. Run after all migrations (scripts/test-db.sh). The whole file runs in one
-- transaction and rolls back, so it leaves no data behind. Any failed check stops the run with an error.

begin;

-- Users (the profile row is created by handle_new_user).
insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000001a0'),
  ('00000000-0000-0000-0000-0000000001b0');
-- Finance (fa): payment capture and provider settlement need a signed-in finance user with MFA, so the whole file
-- runs as this user. Blocks that need another identity set it themselves.
insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000fa');
insert into auth.mfa_factors (user_id, status) values ('00000000-0000-0000-0000-0000000000fa', 'verified');
select set_config('request.jwt.claim.role', 'service_role', false);
update public.profiles set role = 'finance' where id = '00000000-0000-0000-0000-0000000000fa';
select set_config('request.jwt.claim.role', '', false);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000fa', false);
select set_config('request.jwt.claims', '{"aal":"aal2"}', false);

-- Test helpers (docs/25, section 9). A payment changes only through request_payment_capture and
-- apply_payment_provider_event, so these helpers drive exactly those functions, as the backend does: with no signed-in
-- user present. Each helper restores the caller's session identity, including when the call raises.
create function pg_temp.start_payment(p_booking uuid, p_ref text, p_amount bigint) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  insert into public.payments (booking_id, provider, provider_reference, amount_minor, currency, status, reference, expires_at)
  values (p_booking, 'fixture', p_ref, p_amount, 'NGN', 'initiated', 'res-' || p_ref, now() + interval '1 hour')
  returning id into v_id;
  return v_id;
end $$;

create function pg_temp.ev(p_ref text, p_event_id text, p_type text, p_state text, p_amount bigint,
                           p_verification text default 'webhook_signature', p_digest text default null,
                           p_at timestamptz default now()) returns text
language plpgsql as $$
declare
  v_sub text := current_setting('request.jwt.claim.sub', true);
  v_claims text := current_setting('request.jwt.claims', true);
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
  begin
    v_out := public.apply_payment_provider_event('fixture', p_event_id, p_type, p_ref, p_state, p_amount, 'NGN', p_at,
      p_verification, coalesce(p_digest, encode(sha256(convert_to(p_event_id, 'UTF8')), 'hex')));
  exception when others then
    perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
    perform set_config('request.jwt.claims', coalesce(v_claims, '{}'), true);
    raise;
  end;
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  perform set_config('request.jwt.claims', coalesce(v_claims, '{}'), true);
  return v_out;
end $$;

create function pg_temp.ev_state(p_ref text, p_event_id text, p_state text, p_amount bigint) returns text
language plpgsql as $$
begin
  return pg_temp.ev(p_ref, p_event_id, 'payment.' || p_state, p_state, p_amount);
end $$;

create function pg_temp.request_capture(p_payment uuid) returns void
language plpgsql as $$
declare
  v_sub text := current_setting('request.jwt.claim.sub', true);
  v_claims text := current_setting('request.jwt.claims', true);
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
  begin
    perform public.request_payment_capture(p_payment, 'capture-workflow');
  exception when others then
    perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
    perform set_config('request.jwt.claims', coalesce(v_claims, '{}'), true);
    raise;
  end;
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  perform set_config('request.jwt.claims', coalesce(v_claims, '{}'), true);
end $$;

-- The full approved path for one payment: authorised by the provider, capture requested by the backend (only after
-- ticket verification), captured on the provider's confirmation.
create function pg_temp.capture_payment(p_booking uuid, p_ref text, p_amount bigint) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  v_id := pg_temp.start_payment(p_booking, p_ref, p_amount);
  if pg_temp.ev_state(p_ref, p_ref || '-auth', 'authorised', p_amount) <> 'applied' then
    raise exception 'FAIL capture_payment: authorisation was not applied';
  end if;
  perform pg_temp.request_capture(v_id);
  if pg_temp.ev_state(p_ref, p_ref || '-cap', 'captured', p_amount) <> 'applied' then
    raise exception 'FAIL capture_payment: the provider confirmation was not applied';
  end if;
  return v_id;
end $$;

-- Helper data: one passenger per booking, added where a scenario needs one.
do $$
declare
  n integer;
  pass uuid;
  bk uuid;
  owner uuid := '00000000-0000-0000-0000-0000000001a0';
begin
  -- ---------------------------------------------------------------------------
  -- A. The approved path, end to end, with every milestone.
  -- ---------------------------------------------------------------------------
  insert into public.bookings (id, user_id, display_currency, display_amount_minor)
  values ('00000000-0000-0000-0000-0000000002a1', owner, 'NGN', 1500000)
  returning id into bk;

  insert into public.passengers (id, booking_id, first_name, last_name, date_of_birth, nationality)
  values ('00000000-0000-0000-0000-0000000003a1', bk, 'Ada', 'Okafor', '1990-05-14', 'NG');
  pass := '00000000-0000-0000-0000-0000000003a1';

  update public.bookings set booking_status = 'quoted', quoted_at = now() where id = bk;
  update public.bookings set booking_status = 'authorised', authorised_at = now() where id = bk;
  update public.bookings
     set booking_status = 'partner_ordered', partner_order_confirmed_at = now(), ticketing_partner = 'Test Partner Ltd'
   where id = bk;
  update public.bookings set booking_status = 'ticketing_pending' where id = bk;
  insert into public.tickets (booking_id, passenger_id, ticket_number_ciphertext, ticket_number_key_id, ticket_number_hash)
  values (bk, pass, 'v1.k1.iv.tag.ct', 'k1', repeat('b', 64));
  update public.bookings set booking_status = 'tickets_issued', tickets_issued_at = now() where id = bk;

  -- Verification is GO's own step. Only a verified ticket allows the booking to move on.
  update public.tickets set verified_at = now() where passenger_id = pass;
  update public.bookings set booking_status = 'verified', tickets_verified_at = now() where id = bk;

  perform pg_temp.capture_payment(bk, 'lc-path-1', 1500000);
  update public.bookings set booking_status = 'captured', captured_at = now() where id = bk;
    update public.bookings set booking_status = 'confirmed', confirmed_at = now() where id = bk;

  if (select booking_status from public.bookings where id = bk) <> 'confirmed' then
    raise exception 'FAIL A: the approved path did not reach confirmed';
  end if;
  raise notice 'PASS A: approved path reaches confirmed with every milestone';
end $$;

-- ---------------------------------------------------------------------------
-- B. Illegal and skipped transitions are rejected by the database.
-- ---------------------------------------------------------------------------
do $$
declare
  owner uuid := '00000000-0000-0000-0000-0000000001a0';
  bk uuid := '00000000-0000-0000-0000-0000000002b1';
begin
  insert into public.bookings (id, user_id, display_currency, display_amount_minor)
  values (bk, owner, 'NGN', 100);

  begin
    update public.bookings set booking_status = 'verified' where id = bk;
    raise exception 'FAIL B1: draft moved straight to verified';
  exception when check_violation then null; end;

  begin
    update public.bookings set booking_status = 'captured' where id = bk;
    raise exception 'FAIL B2: draft moved straight to captured';
  exception when check_violation then null; end;

  update public.bookings set booking_status = 'quoted', quoted_at = now() where id = bk;
  update public.bookings set booking_status = 'failed' where id = bk;

  begin
    update public.bookings set booking_status = 'quoted', quoted_at = now() where id = bk;
    raise exception 'FAIL B3: a failed booking was re-opened';
  exception when check_violation then null; end;

  begin
    insert into public.bookings (user_id, booking_status, display_currency, display_amount_minor)
    values (owner, 'quoted', 'NGN', 100);
    raise exception 'FAIL B4: a booking was created outside draft';
  exception when check_violation then null; end;

  raise notice 'PASS B: illegal, skipped and terminal transitions are rejected';
end $$;

-- ---------------------------------------------------------------------------
-- C. Milestones must match the state, and must be ordered.
-- ---------------------------------------------------------------------------
do $$
declare
  owner uuid := '00000000-0000-0000-0000-0000000001a0';
  bk uuid := '00000000-0000-0000-0000-0000000002c1';
begin
  insert into public.bookings (id, user_id, display_currency, display_amount_minor)
  values (bk, owner, 'NGN', 100);
  update public.bookings set booking_status = 'quoted', quoted_at = now() where id = bk;

  begin
    update public.bookings set booking_status = 'authorised' where id = bk;
    raise exception 'FAIL C1: authorised accepted without authorised_at';
  exception when check_violation then null; end;

  update public.bookings set booking_status = 'authorised', authorised_at = now() where id = bk;

  begin
    update public.bookings set tickets_issued_at = now() where id = bk;
    raise exception 'FAIL C2: tickets_issued_at accepted without a partner order';
  exception when check_violation then null; end;

  begin
    update public.bookings
       set booking_status = 'partner_ordered', partner_order_confirmed_at = now()
     where id = bk;
    raise exception 'FAIL C3: partner order accepted without a named ticketing partner';
  exception when check_violation then null; end;

  begin
    update public.bookings
       set booking_status = 'partner_ordered', partner_order_confirmed_at = now(), ticketing_partner = ''
     where id = bk;
    raise exception 'FAIL C4: empty ticketing partner accepted';
  exception when check_violation then null; end;

  raise notice 'PASS C: milestones are required in order and by state';
end $$;

-- ---------------------------------------------------------------------------
-- D. Funding: GO never funds supplier ticket issuance. The only funding model is partner_funded.
-- ---------------------------------------------------------------------------
do $$
declare
  owner uuid := '00000000-0000-0000-0000-0000000001a0';
begin
  begin
    insert into public.bookings (user_id, display_currency, display_amount_minor, funding_model)
    values (owner, 'NGN', 100, 'go_funded');
    raise exception 'FAIL D1: a GO-funded booking was accepted';
  exception when check_violation then null; end;
  raise notice 'PASS D: GO-funded bookings are rejected';
end $$;

-- ---------------------------------------------------------------------------
-- E. Verification and capture gates.
-- ---------------------------------------------------------------------------
do $$
declare
  owner uuid := '00000000-0000-0000-0000-0000000001a0';
  bk uuid := '00000000-0000-0000-0000-0000000002e1';
  pass uuid := '00000000-0000-0000-0000-0000000003c9';
begin
  insert into public.bookings (id, user_id, display_currency, display_amount_minor)
  values (bk, owner, 'NGN', 100);
  insert into public.passengers (id, booking_id, first_name, last_name, date_of_birth, nationality)
  values (pass, bk, 'Chidi', 'Eze', '1985-02-02', 'NG');
  update public.bookings set booking_status = 'quoted', quoted_at = now() where id = bk;
  update public.bookings set booking_status = 'authorised', authorised_at = now() where id = bk;
  update public.bookings
     set booking_status = 'partner_ordered', partner_order_confirmed_at = now(), ticketing_partner = 'Test Partner Ltd'
   where id = bk;
  insert into public.tickets (booking_id, passenger_id, ticket_number_ciphertext, ticket_number_key_id, ticket_number_hash)
  values (bk, pass, 'v1.k1.iv3.tag3.ct3', 'k1', repeat('c', 64));
  update public.bookings set booking_status = 'tickets_issued', tickets_issued_at = now() where id = bk;

  begin
    update public.bookings set booking_status = 'verified', tickets_verified_at = now() where id = bk;
    raise exception 'FAIL E1: booking verified with an unverified ticket';
  exception when check_violation then null; end;

  begin
    perform pg_temp.start_payment(bk, 'lc-early-1', 100);
    perform pg_temp.ev_state('lc-early-1', 'lc-early-ev-1', 'authorised', 100);
    perform pg_temp.request_capture((select id from public.payments where provider_reference = 'lc-early-1'));
    raise exception 'FAIL E2: capture was requested before the booking was verified';
  exception when check_violation then null; end;

  raise notice 'PASS E: capture is refused before GO verification';
end $$;

-- ---------------------------------------------------------------------------
-- F. A booking cannot be captured without a captured payment.
-- ---------------------------------------------------------------------------
do $$
declare
  owner uuid := '00000000-0000-0000-0000-0000000001a0';
  bk uuid := '00000000-0000-0000-0000-0000000002f1';
  pass uuid := '00000000-0000-0000-0000-0000000003f1';
begin
  insert into public.bookings (id, user_id, display_currency, display_amount_minor)
  values (bk, owner, 'NGN', 100);
  insert into public.passengers (id, booking_id, first_name, last_name, date_of_birth, nationality)
  values (pass, bk, 'Tunde', 'Bello', '1979-09-09', 'NG');
  update public.bookings set booking_status = 'quoted', quoted_at = now() where id = bk;
  update public.bookings set booking_status = 'authorised', authorised_at = now() where id = bk;
  update public.bookings
     set booking_status = 'partner_ordered', partner_order_confirmed_at = now(), ticketing_partner = 'Test Partner Ltd'
   where id = bk;
  insert into public.tickets (booking_id, passenger_id, ticket_number_ciphertext, ticket_number_key_id, ticket_number_hash)
  values (bk, pass, 'v1.k1.iv4.tag4.ct4', 'k1', repeat('d', 64));
  update public.bookings set booking_status = 'tickets_issued', tickets_issued_at = now() where id = bk;
  update public.tickets set verified_at = now() where passenger_id = pass;
  update public.bookings set booking_status = 'verified', tickets_verified_at = now() where id = bk;

  begin
    update public.bookings set booking_status = 'captured', captured_at = now() where id = bk;
    raise exception 'FAIL F: booking captured without a captured payment';
  exception when check_violation then null; end;

  raise notice 'PASS F: a booking cannot be captured without a captured payment';
end $$;

-- ---------------------------------------------------------------------------
-- G. ISO 4217 currency handling.
-- ---------------------------------------------------------------------------
do $$
declare
  owner uuid := '00000000-0000-0000-0000-0000000001a0';
  n integer;
begin
  select count(*) into n from public.currency_codes where list_status = 'current';
  if n <> 155 then raise exception 'FAIL G0: expected 155 current currencies, found %', n; end if;

  -- An ISO current currency outside the old four-code list is accepted.
  insert into public.bookings (user_id, display_currency, display_amount_minor) values (owner, 'IQD', 100);

  -- A code that is not in the reference table is refused by the foreign key.
  begin
    insert into public.bookings (user_id, display_currency, display_amount_minor) values (owner, 'XXX', 100);
    raise exception 'FAIL G1: a non-currency code was accepted';
  exception when check_violation or foreign_key_violation then null; end;

  -- A fund code (UYW) is not an ordinary currency, so it is not in the table.
  begin
    insert into public.bookings (user_id, display_currency, display_amount_minor) values (owner, 'UYW', 100);
    raise exception 'FAIL G2: a fund code was accepted as a currency';
  exception when check_violation or foreign_key_violation then null; end;

  -- A legacy code is readable on existing rows but refused for new records.
  begin
    insert into public.bookings (user_id, display_currency, display_amount_minor) values (owner, 'HRK', 100);
    raise exception 'FAIL G3: a legacy code was accepted for a new booking';
  exception when check_violation then null; end;

  raise notice 'PASS G: ISO 4217 codes are accepted, legacy and non-currency codes are refused';
end $$;

-- ---------------------------------------------------------------------------
-- H. The database transition table has exactly the 55 pairs in the TypeScript table.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  select count(*) into n
  from unnest(array['draft','quoted','authorised','order_unknown','partner_ordered','ticketing_pending','ticketing_unknown',
    'tickets_issued','partially_fulfilled','verified','verification_failed','captured','confirmed','review_required',
    'failed','expired','cancellation_pending','cancelled','refund_pending','refunded']::text[]) a(s)
  cross join unnest(array['draft','quoted','authorised','order_unknown','partner_ordered','ticketing_pending','ticketing_unknown',
    'tickets_issued','partially_fulfilled','verified','verification_failed','captured','confirmed','review_required',
    'failed','expired','cancellation_pending','cancelled','refund_pending','refunded']::text[]) b(s)
  where public.booking_transition_allowed(a.s, b.s);
  if n <> 55 then raise exception 'FAIL H: transition table has % pairs, expected 55', n; end if;
  raise notice 'PASS H: the database transition table has 55 pairs';
end $$;


-- ---------------------------------------------------------------------------
-- I. Provider settlement is a separate money flow. A confirmed booking does not wait for it, and it can be
--    recorded only against a captured payment.
-- ---------------------------------------------------------------------------
do $$
declare
  owner uuid := '00000000-0000-0000-0000-0000000001a0';
  bk uuid := '00000000-0000-0000-0000-0000000002a9';
  pass uuid := '00000000-0000-0000-0000-0000000003a9';
  settled_value timestamptz;
begin
  insert into public.bookings (id, user_id, display_currency, display_amount_minor)
  values (bk, owner, 'NGN', 100);
  insert into public.passengers (id, booking_id, first_name, last_name, date_of_birth, nationality)
  values (pass, bk, 'Funmi', 'Adeyemi', '1992-03-03', 'NG');
  update public.bookings set booking_status = 'quoted', quoted_at = now() where id = bk;
  update public.bookings set booking_status = 'authorised', authorised_at = now() where id = bk;
  update public.bookings
     set booking_status = 'partner_ordered', partner_order_confirmed_at = now(), ticketing_partner = 'Test Partner Ltd'
   where id = bk;
  insert into public.tickets (booking_id, passenger_id, ticket_number_ciphertext, ticket_number_key_id, ticket_number_hash)
  values (bk, pass, 'v1.k1.iv9.tag9.ct9', 'k1', repeat('e', 64));
  update public.bookings set booking_status = 'tickets_issued', tickets_issued_at = now() where id = bk;
  update public.tickets set verified_at = now() where passenger_id = pass;
  update public.bookings set booking_status = 'verified', tickets_verified_at = now() where id = bk;
  perform pg_temp.capture_payment(bk, 'lc-set-1', 100);
  update public.bookings set booking_status = 'captured', captured_at = now() where id = bk;

  -- Confirmation needs no provider settlement: the payment has none, and the booking still confirms.
  if (select provider_settled_at from public.payments where booking_id = bk) is not null then
    raise exception 'FAIL I0: a new payment already has a provider settlement';
  end if;
  update public.bookings set booking_status = 'confirmed', confirmed_at = now() where id = bk;
  if (select booking_status from public.bookings where id = bk) <> 'confirmed' then
    raise exception 'FAIL I1: booking did not confirm without provider settlement';
  end if;

  -- The provider settles later, through its settlement event. The booking is unaffected.
  if pg_temp.ev('lc-set-1', 'lc-set-1-settle', 'settlement', 'captured', 100) <> 'applied' then
    raise exception 'FAIL I2: provider settlement was not recorded on a captured payment';
  end if;
  select provider_settled_at into settled_value from public.payments where booking_id = bk;
  if settled_value is null then raise exception 'FAIL I2: provider settlement was not stored'; end if;

  -- A second settlement for the same payment is refused.
  if pg_temp.ev('lc-set-1', 'lc-set-1-settle-2', 'settlement', 'captured', 100) <> 'rejected' then
    raise exception 'FAIL I3: a second provider settlement was accepted';
  end if;

  raise notice 'PASS I: confirmation does not depend on provider settlement; settlement needs a captured payment';
end $$;

-- ---------------------------------------------------------------------------
-- J. Customers read a ticket only after GO verification, and only in a visible booking state (RLS).
-- ---------------------------------------------------------------------------
do $$
declare
  owner uuid := '00000000-0000-0000-0000-0000000001a0';
  bk uuid := '00000000-0000-0000-0000-0000000002b9';
  pass uuid := '00000000-0000-0000-0000-0000000003b9';
  n integer;
begin
  insert into public.bookings (id, user_id, display_currency, display_amount_minor)
  values (bk, owner, 'NGN', 100);
  insert into public.passengers (id, booking_id, first_name, last_name, date_of_birth, nationality)
  values (pass, bk, 'Ngozi', 'Obi', '1988-06-06', 'NG');
  update public.bookings set booking_status = 'quoted', quoted_at = now() where id = bk;
  update public.bookings set booking_status = 'authorised', authorised_at = now() where id = bk;
  update public.bookings
     set booking_status = 'partner_ordered', partner_order_confirmed_at = now(), ticketing_partner = 'Test Partner Ltd'
   where id = bk;
  insert into public.tickets (booking_id, passenger_id, ticket_number_ciphertext, ticket_number_key_id, ticket_number_hash)
  values (bk, pass, 'v1.k1.iv10.tag10.ct10', 'k1', repeat('f', 64));
  update public.bookings set booking_status = 'tickets_issued', tickets_issued_at = now() where id = bk;

  -- J1: issued but not verified: the customer cannot read the ticket.
  perform set_config('request.jwt.claim.sub', owner::text, true);
  set local role authenticated;
  select count(*) into n from public.tickets where booking_id = bk;
  reset role;
  if n <> 0 then raise exception 'FAIL J1: customer read an unverified ticket'; end if;

  -- J2: GO verifies the ticket while the booking is still tickets_issued. The state gate still hides it.
  update public.tickets set verified_at = now() where passenger_id = pass;
  perform set_config('request.jwt.claim.sub', owner::text, true);
  set local role authenticated;
  select count(*) into n from public.tickets where booking_id = bk;
  reset role;
  if n <> 0 then raise exception 'FAIL J2: customer read a ticket on a booking that is not yet verified'; end if;

  -- J3: the booking is verified: the customer can read the ticket.
  update public.bookings set booking_status = 'verified', tickets_verified_at = now() where id = bk;
  perform set_config('request.jwt.claim.sub', owner::text, true);
  set local role authenticated;
  select count(*) into n from public.tickets where booking_id = bk;
  reset role;
  if n <> 1 then raise exception 'FAIL J3: customer cannot read a verified ticket on a verified booking (found %)', n; end if;

  raise notice 'PASS J: customers see a ticket only after verification, in a visible booking state';
end $$;


-- ---------------------------------------------------------------------------
-- K. Partner remittance rules, run in the database (the trigger, not only the API). Actors: finance (fa), admin (ad),
--    support (ee). Superuser sessions skip RLS, so these checks prove the trigger refuses on its own.
-- ---------------------------------------------------------------------------
insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000ad'),
  ('00000000-0000-0000-0000-0000000000ee'),
  ('00000000-0000-0000-0000-0000000000b0');
insert into auth.mfa_factors (user_id, status) values
  ('00000000-0000-0000-0000-0000000000ad', 'verified'),
  ('00000000-0000-0000-0000-0000000000ee', 'verified'),
  ('00000000-0000-0000-0000-0000000000b0', 'verified');
select set_config('request.jwt.claim.role', 'service_role', false);
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000ad';
update public.profiles set role = 'support' where id = '00000000-0000-0000-0000-0000000000ee';
update public.profiles set role = 'operations' where id = '00000000-0000-0000-0000-0000000000b0';
select set_config('request.jwt.claim.role', '', false);

create function pg_temp.make_ordered_booking(bk uuid, owner uuid) returns void
language plpgsql as $$
begin
  insert into public.bookings (id, user_id, display_currency, display_amount_minor) values (bk, owner, 'NGN', 100);
  update public.bookings set booking_status = 'quoted', quoted_at = now() where id = bk;
  update public.bookings set booking_status = 'authorised', authorised_at = now() where id = bk;
  update public.bookings set booking_status = 'partner_ordered', partner_order_confirmed_at = now(),
    ticketing_partner = 'Test Partner Ltd' where id = bk;
end $$;

-- Sets the signed-in user and the MFA level for the rest of the transaction (or for the current statement's role).
create function pg_temp.act_as(u uuid, aal text) returns void
language plpgsql as $$
begin
  if u is null then
    perform set_config('request.jwt.claim.sub', '', true);
  else
    perform set_config('request.jwt.claim.sub', u::text, true);
  end if;
  perform set_config('request.jwt.claims', case when aal is null then '{}' else json_build_object('aal', aal)::text end, true);
end $$;

do $$
declare
  owner uuid := '00000000-0000-0000-0000-0000000001a0';
  finance uuid := '00000000-0000-0000-0000-0000000000fa';
  admin uuid := '00000000-0000-0000-0000-0000000000ad';
  staff uuid := '00000000-0000-0000-0000-0000000000ee';
  bk1 uuid := '00000000-0000-0000-0000-0000000002d1';
  bk2 uuid := '00000000-0000-0000-0000-0000000002d2';
  bk3 uuid := '00000000-0000-0000-0000-0000000002d3';
  bk4 uuid := '00000000-0000-0000-0000-0000000002d4';
  st text;
  n integer;
begin
  perform pg_temp.make_ordered_booking(bk1, owner);
  perform pg_temp.make_ordered_booking(bk2, owner);
  perform pg_temp.make_ordered_booking(bk3, owner);

  -- K1: finance creates a pending remittance from the agreement. The booking does not change.
  perform pg_temp.act_as(finance, 'aal2');
  insert into public.partner_remittances (booking_id, status, agreement_reference, agreement_clause, agreement_recorded_by,
    amount_minor, currency, due_at)
  values (bk1, 'pending', 'PA-2026-001', 'Clause 4.2', finance, 45000, 'NGN', now() + interval '30 days');
  select booking_status into st from public.bookings where id = bk1;
  if st <> 'partner_ordered' then raise exception 'FAIL K1: a remittance changed the booking to %', st; end if;

  -- K2: support staff are refused by the trigger itself (no remittance access), even in a superuser session.
  perform pg_temp.act_as(staff, 'aal2');
  begin
    update public.partner_remittances set status_reason = 'support note' where booking_id = bk1;
    raise exception 'FAIL K2: support staff changed a remittance';
  exception when check_violation then null; end;

  -- K3: finance marks failed only with a reason.
  perform pg_temp.act_as(finance, 'aal2');
  begin
    update public.partner_remittances set status = 'failed' where booking_id = bk1;
    raise exception 'FAIL K3a: a failed remittance was accepted without a reason';
  exception when check_violation then null; end;
  update public.partner_remittances set status = 'failed', status_reason = 'Partner bank rejected the transfer' where booking_id = bk1;

  -- K4: recovery needs a note, and is counted.
  begin
    update public.partner_remittances set status = 'pending', status_reason = null where booking_id = bk1;
    raise exception 'FAIL K4a: a recovery attempt was accepted without a note';
  exception when check_violation then null; end;
  update public.partner_remittances set status = 'pending', status_reason = 'Bank details corrected from the agreement' where booking_id = bk1;
  select attempt_count into n from public.partner_remittances where booking_id = bk1;
  if n <> 2 then raise exception 'FAIL K4b: attempt count is % after one recovery, expected 2', n; end if;

  -- K5: finance cannot correct agreement terms.
  begin
    update public.partner_remittances set amount_minor = 40000 where booking_id = bk1;
    raise exception 'FAIL K5: finance corrected an agreed amount';
  exception when check_violation then null; end;

  -- K6: an administrator corrects a term with a reason, and the change is audited.
  perform pg_temp.act_as(admin, 'aal2');
  update public.partner_remittances set status_reason = null where booking_id = bk1;
  begin
    update public.partner_remittances set amount_minor = 40000 where booking_id = bk1;
    raise exception 'FAIL K6a: an agreed amount was corrected without a reason';
  exception when check_violation then null; end;
  update public.partner_remittances set amount_minor = 40000,
    status_reason = 'Agreement schedule 2 amount, confirmed by the partner' where booking_id = bk1;
  select count(*) into n from public.partner_remittance_events e
    join public.partner_remittances r on r.id = e.remittance_id
    where r.booking_id = bk1 and e.action = 'changed';
  if n < 1 then raise exception 'FAIL K6b: a correction was not recorded in the audit trail'; end if;

  -- K7: finance moves to under review, but only an administrator may mark paid, and only with a reference.
  perform pg_temp.act_as(finance, 'aal2');
  update public.partner_remittances set status = 'under_review', status_reason = 'Partner asked for proof of transfer' where booking_id = bk1;
  begin
    update public.partner_remittances set status = 'paid', payment_reference = 'TRF-K7', paid_at = now() where booking_id = bk1;
    raise exception 'FAIL K7a: finance marked a remittance paid';
  exception when check_violation then null; end;
  perform pg_temp.act_as(admin, 'aal2');
  begin
    update public.partner_remittances set status = 'paid' where booking_id = bk1;
    raise exception 'FAIL K7b: a remittance was marked paid without a reference';
  exception when check_violation then null; end;
  update public.partner_remittances set status = 'paid', payment_reference = 'TRF-K7', paid_at = now() where booking_id = bk1;
  select booking_status into st from public.bookings where id = bk1;
  if st <> 'partner_ordered' then raise exception 'FAIL K7c: paying a remittance changed the booking to %', st; end if;

  -- K8: a paid remittance is final, including its amount.
  begin
    update public.partner_remittances set status = 'pending', status_reason = 'reopen' where booking_id = bk1;
    raise exception 'FAIL K8a: a paid remittance was reopened';
  exception when check_violation then null; end;
  begin
    update public.partner_remittances set amount_minor = 1 where booking_id = bk1;
    raise exception 'FAIL K8b: a paid remittance amount was changed';
  exception when check_violation then null; end;

  -- K9: not required. Finance cannot record it. An administrator records it, approved by the signed-in administrator.
  perform pg_temp.act_as(finance, 'aal2');
  begin
    insert into public.partner_remittances (booking_id, status, agreement_reference, agreement_clause, agreement_recorded_by,
      no_obligation_approved_by, no_obligation_approved_at, no_obligation_evidence)
    values (bk2, 'not_required', 'PA-2026-002', 'Clause 9.1', finance, finance, now(),
      'Agreement 9.1: no remittance is owed for ticket-only sales.');
    raise exception 'FAIL K9a: finance recorded a not-required remittance';
  exception when check_violation then null; end;
  perform pg_temp.act_as(admin, 'aal2');
  begin
    insert into public.partner_remittances (booking_id, status, agreement_reference, agreement_clause, agreement_recorded_by,
      no_obligation_approved_by, no_obligation_approved_at, no_obligation_evidence)
    values (bk2, 'not_required', 'PA-2026-002', 'Clause 9.1', admin, finance, now(),
      'Agreement 9.1: no remittance is owed for ticket-only sales.');
    raise exception 'FAIL K9b: the approval was given by someone other than the signed-in administrator';
  exception when check_violation then null; end;
  begin
    insert into public.partner_remittances (booking_id, status, agreement_reference, agreement_clause, agreement_recorded_by,
      no_obligation_approved_by, no_obligation_approved_at)
    values (bk2, 'not_required', 'PA-2026-002', 'Clause 9.1', admin, admin, now());
    raise exception 'FAIL K9c: a not-required remittance was recorded without evidence';
  exception when check_violation then null; end;
  begin
    insert into public.partner_remittances (booking_id, status, agreement_reference, agreement_clause, agreement_recorded_by,
      amount_minor, no_obligation_approved_by, no_obligation_approved_at, no_obligation_evidence)
    values (bk2, 'not_required', 'PA-2026-002', 'Clause 9.1', admin, 100, admin, now(),
      'Agreement 9.1: no remittance is owed for ticket-only sales.');
    raise exception 'FAIL K9d: a not-required remittance carried an amount';
  exception when check_violation then null; end;
  insert into public.partner_remittances (booking_id, status, agreement_reference, agreement_clause, agreement_recorded_by,
    no_obligation_approved_by, no_obligation_approved_at, no_obligation_evidence)
  values (bk2, 'not_required', 'PA-2026-002', 'Clause 9.1', admin, admin, now(),
    'Agreement 9.1: no remittance is owed for ticket-only sales.');
  begin
    update public.partner_remittances set no_obligation_evidence = 'Changed after the fact, with no basis.' where booking_id = bk2;
    raise exception 'FAIL K9e: no-obligation evidence was changed after it was recorded';
  exception when check_violation then null; end;

  -- K10: a remittance cannot be created as paid, without an amount, or with an unknown status.
  begin
    insert into public.partner_remittances (booking_id, status, agreement_reference, agreement_clause, agreement_recorded_by,
      amount_minor, currency, due_at, payment_reference, paid_at)
    values (bk3, 'paid', 'PA-X', 'Clause X', admin, 1, 'NGN', now(), 'x', now());
    raise exception 'FAIL K10a: a remittance was created as paid';
  exception when check_violation then null; end;
  begin
    insert into public.partner_remittances (booking_id, status, agreement_reference, agreement_clause, agreement_recorded_by)
    values (bk3, 'pending', 'PA-3', 'Clause 3', admin);
    raise exception 'FAIL K10b: a pending remittance was created without an amount, currency and due date';
  exception when check_violation then null; end;
  begin
    insert into public.partner_remittances (booking_id, status, agreement_reference, agreement_clause, agreement_recorded_by,
      amount_minor, currency, due_at)
    values (bk3, 'maybe', 'PA-3', 'Clause 3', admin, 1, 'NGN', now());
    raise exception 'FAIL K10c: an unknown remittance status was accepted';
  exception when check_violation then null; end;

  -- K11: a remittance needs a booking that has a partner order.
  insert into public.bookings (id, user_id, display_currency, display_amount_minor) values (bk4, owner, 'NGN', 100);
  begin
    insert into public.partner_remittances (booking_id, status, agreement_reference, agreement_clause, agreement_recorded_by,
      amount_minor, currency, due_at)
    values (bk4, 'pending', 'PA-4', 'Clause 4', admin, 1, 'NGN', now());
    raise exception 'FAIL K11: a remittance was created for a booking with no partner order';
  exception when check_violation then null; end;

  -- K12: no unauthenticated change, including the service role, to a remittance.
  perform pg_temp.act_as(null, null);
  begin
    update public.partner_remittances set status_reason = 'service role note' where booking_id = bk1;
    raise exception 'FAIL K12: a change with no authenticated actor was accepted';
  exception when check_violation then null; end;

  -- K13: the audit trail is append-only and cannot be truncated, for every role.
  begin
    update public.partner_remittance_events set reason = 'tampered';
    raise exception 'FAIL K13a: an audit event was updated';
  exception when check_violation then null; end;
  begin
    delete from public.partner_remittance_events;
    raise exception 'FAIL K13b: an audit event was deleted';
  exception when check_violation then null; end;
  select count(*) into n from public.partner_remittance_events;
  if n < 5 then raise exception 'FAIL K13c: the audit trail holds only % events', n; end if;

  perform pg_temp.act_as(finance, 'aal2');
  raise notice 'PASS K: remittance rules are enforced by the trigger, with finance, administrator and service-role cases';
end $$;

-- ---------------------------------------------------------------------------
-- L. Access matrix for remittances and their audit trail, through the authenticated role and RLS.
--    Finance and administrators: full access. Support, operations and customers: nothing. Unauthenticated: nothing.
-- ---------------------------------------------------------------------------
do $$
declare
  owner uuid := '00000000-0000-0000-0000-0000000001a0';
  finance uuid := '00000000-0000-0000-0000-0000000000fa';
  admin uuid := '00000000-0000-0000-0000-0000000000ad';
  staff uuid := '00000000-0000-0000-0000-0000000000ee';
  ops uuid := '00000000-0000-0000-0000-0000000000b0';
  bk5 uuid := '00000000-0000-0000-0000-0000000002d5';
  bk6 uuid := '00000000-0000-0000-0000-0000000002d6';
  bk7 uuid := '00000000-0000-0000-0000-0000000002d7';
  n integer;
begin
  perform pg_temp.make_ordered_booking(bk5, owner);
  perform pg_temp.make_ordered_booking(bk6, owner);
  perform pg_temp.make_ordered_booking(bk7, owner);
  perform pg_temp.act_as(finance, 'aal2');
  insert into public.partner_remittances (booking_id, status, agreement_reference, agreement_clause, agreement_recorded_by,
    amount_minor, currency, due_at)
  values (bk5, 'pending', 'PA-5', 'Clause 5', finance, 100, 'NGN', now() + interval '1 day');

  -- Customer, support and operations: no rows, no change, no creation (RLS and the authenticated role).
  perform pg_temp.act_as(owner, null);
  set local role authenticated;
  select count(*) into n from public.partner_remittances;
  if n <> 0 then raise exception 'FAIL L1: a customer reads % remittance(s)', n; end if;
  select count(*) into n from public.partner_remittance_events;
  if n <> 0 then raise exception 'FAIL L2: a customer reads % audit event(s)', n; end if;
  reset role;

  perform pg_temp.act_as(ops, 'aal2');
  set local role authenticated;
  select count(*) into n from public.partner_remittances;
  if n <> 0 then raise exception 'FAIL L3: operations staff read % remittance(s)', n; end if;
  select count(*) into n from public.partner_remittance_events;
  if n <> 0 then raise exception 'FAIL L4: operations staff read % audit event(s)', n; end if;
  update public.partner_remittances set status_reason = 'operations note' where booking_id = bk5;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL L5: operations staff changed % remittance(s)', n; end if;
  begin
    insert into public.partner_remittances (booking_id, status, agreement_reference, agreement_clause, agreement_recorded_by,
      amount_minor, currency, due_at)
    values (bk6, 'pending', 'PA-6', 'Clause 6', ops, 100, 'NGN', now());
    raise exception 'FAIL L6: operations staff created a remittance';
  exception when insufficient_privilege or check_violation then null; end;
  reset role;

  perform pg_temp.act_as(staff, 'aal2');
  set local role authenticated;
  select count(*) into n from public.partner_remittances;
  if n <> 0 then raise exception 'FAIL L7: support staff read % remittance(s)', n; end if;
  update public.partner_remittances set status_reason = 'support note' where booking_id = bk5;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL L8: support staff changed % remittance(s)', n; end if;
  begin
    insert into public.partner_remittances (booking_id, status, agreement_reference, agreement_clause, agreement_recorded_by,
      amount_minor, currency, due_at)
    values (bk6, 'pending', 'PA-6', 'Clause 6', staff, 100, 'NGN', now());
    raise exception 'FAIL L9: support staff created a remittance';
  exception when insufficient_privilege or check_violation then null; end;
  reset role;

  -- Unauthenticated: no privilege at all on the tables.
  perform pg_temp.act_as(null, null);
  set local role anon;
  begin
    perform 1 from public.partner_remittances;
    raise exception 'FAIL L10: an unauthenticated user read remittances';
  exception when insufficient_privilege or check_violation then null; end;
  begin
    perform 1 from public.partner_remittance_events;
    raise exception 'FAIL L11: an unauthenticated user read the audit trail';
  exception when insufficient_privilege or check_violation then null; end;
  reset role;

  -- Finance: reads everything, changes status reasons, creates, and fails and retries.
  perform pg_temp.act_as(finance, 'aal2');
  set local role authenticated;
  select count(*) into n from public.partner_remittances;
  if n < 1 then raise exception 'FAIL L12: finance cannot read remittances'; end if;
  select count(*) into n from public.partner_remittance_events;
  if n < 1 then raise exception 'FAIL L13: finance cannot read the audit trail'; end if;
  update public.partner_remittances set status_reason = 'finance review note' where booking_id = bk5;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL L14: finance could not update its remittance (% rows)', n; end if;
  insert into public.partner_remittances (booking_id, status, agreement_reference, agreement_clause, agreement_recorded_by,
    amount_minor, currency, due_at)
  values (bk6, 'pending', 'PA-6', 'Clause 6', finance, 100, 'NGN', now());
  reset role;

  -- Administrator: the same access as finance, plus the administrator-only actions.
  perform pg_temp.act_as(admin, 'aal2');
  set local role authenticated;
  select count(*) into n from public.partner_remittances;
  if n < 2 then raise exception 'FAIL L15: administrator cannot read remittances'; end if;
  insert into public.partner_remittances (booking_id, status, agreement_reference, agreement_clause, agreement_recorded_by,
    amount_minor, currency, due_at)
  values (bk7, 'pending', 'PA-7', 'Clause 7', admin, 100, 'NGN', now());
  reset role;

  raise notice 'PASS L: finance and administrators have remittance access; support, operations, customers and unauthenticated users have none';
end $$;

-- ---------------------------------------------------------------------------
-- P. Capture is two backend steps, and each is refused for every signed-in user (docs/25, section 9).
--    request_payment_capture runs only after independent ticket verification. A provider event sets the result.
--    No signed-in user can change a payment, request capture, or apply a provider event, finance included.
-- ---------------------------------------------------------------------------
do $$
declare
  owner uuid := '00000000-0000-0000-0000-0000000001a0';
  finance uuid := '00000000-0000-0000-0000-0000000000fa';
  admin uuid := '00000000-0000-0000-0000-0000000000ad';
  staff uuid := '00000000-0000-0000-0000-0000000000ee';
  ops uuid := '00000000-0000-0000-0000-0000000000b0';
  bk uuid := '00000000-0000-0000-0000-0000000002c9';
  pass uuid := '00000000-0000-0000-0000-0000000003d9';
  pid uuid;
  u uuid;
  n integer;
  st text;
begin
  perform pg_temp.make_ordered_booking(bk, owner);
  insert into public.passengers (id, booking_id, first_name, last_name, date_of_birth, nationality)
  values (pass, bk, 'Kemi', 'Ade', '1990-01-01', 'NG');
  insert into public.tickets (booking_id, passenger_id, ticket_number_ciphertext, ticket_number_key_id, ticket_number_hash)
  values (bk, pass, 'v1.k1.iv12.tag12.ct12', 'k1', repeat('2', 64));
  update public.bookings set booking_status = 'tickets_issued', tickets_issued_at = now() where id = bk;
  pid := pg_temp.start_payment(bk, 'lc-p-1', 1500000);

  -- P1: the service role cannot change a payment directly: the guard needs the authority of a backend function.
  perform pg_temp.act_as(null, null);
  begin
    update public.payments set status = 'authorised' where id = pid;
    raise exception 'FAIL P1a: a payment was changed with no authority';
  exception when check_violation then null; end;
  begin
    update public.payments set status = 'captured', captured_minor = 1500000 where id = pid;
    raise exception 'FAIL P1b: a payment was marked captured by a direct update';
  exception when check_violation then null; end;
  select status into st from public.payments where id = pid;
  if st <> 'initiated' then raise exception 'FAIL P1c: the payment changed to % without a function', st; end if;

  -- P2: a signed-in finance user with MFA, or an administrator, has no UPDATE on payments at all.
  foreach u in array array[finance, admin] loop
    perform pg_temp.act_as(u, 'aal2');
    set local role authenticated;
    begin
      update public.payments set status = 'authorised' where id = pid;
      raise exception 'FAIL P2: a signed-in user with MFA updated a payment';
    exception when insufficient_privilege then null; end;
    reset role;
  end loop;

  -- P3: no signed-in user (any role, or anonymous) can request capture or apply a provider event: no EXECUTE.
  foreach u in array array[owner, staff, ops, finance, admin] loop
    perform pg_temp.act_as(u, 'aal2');
    set local role authenticated;
    begin
      perform public.request_payment_capture(pid, 'signed-in-attempt');
      raise exception 'FAIL P3a: a signed-in user requested a capture';
    exception when insufficient_privilege then null; end;
    begin
      perform public.apply_payment_provider_event('fixture', 'p3-user', 'payment.captured', 'lc-p-1', 'captured',
        1500000, 'NGN', now(), 'webhook_signature', repeat('c', 64));
      raise exception 'FAIL P3b: a signed-in user applied a provider event';
    exception when insufficient_privilege then null; end;
    reset role;
  end loop;
  perform pg_temp.act_as(null, null);
  set local role anon;
  begin
    perform public.request_payment_capture(pid, 'anon-attempt');
    raise exception 'FAIL P3c: an anonymous caller requested a capture';
  exception when insufficient_privilege then null; end;
  reset role;

  -- P4: capture is refused before the tickets are independently verified.
  perform pg_temp.ev_state('lc-p-1', 'lc-p-auth', 'authorised', 1500000);
  begin
    perform pg_temp.request_capture(pid);
    raise exception 'FAIL P4: capture was requested before the tickets were verified';
  exception when check_violation then null; end;

  -- Verify every ticket, then the approved path runs.
  update public.tickets set verified_at = now() where passenger_id = pass;
  update public.bookings set booking_status = 'verified', tickets_verified_at = now() where id = bk;

  -- P5: the backend requests capture. The request alone does not capture the payment.
  perform pg_temp.request_capture(pid);
  select status into st from public.payments where id = pid;
  if st <> 'capture_requested' then raise exception 'FAIL P5a: the request left the payment in %', st; end if;
  -- A second request is refused (only an authorised payment can be sent).
  begin
    perform pg_temp.request_capture(pid);
    raise exception 'FAIL P5b: a second capture request was accepted';
  exception when check_violation then null; end;

  -- P6: the provider's confirmation captures it, once, for the full amount.
  if pg_temp.ev_state('lc-p-1', 'lc-p-cap', 'captured', 1500000) <> 'applied' then
    raise exception 'FAIL P6a: the provider confirmation was not applied';
  end if;
  select status, captured_minor into st, n from public.payments where id = pid;
  if st <> 'captured' or n <> 1500000 then raise exception 'FAIL P6b: payment is % with captured %', st, n; end if;

  -- P7: a captured amount cannot change, even from the backend.
  begin
    update public.payments set captured_minor = 1 where id = pid;
    raise exception 'FAIL P7: a captured amount was changed';
  exception when check_violation then null; end;

  -- P8: every financial change is attributed: the request to the backend workflow, the capture to the provider event.
  select count(*) into n from public.payment_financial_events
    where payment_id = pid and action = 'capture_requested' and actor_kind = 'backend_workflow'
      and actor_label = 'backend:capture-workflow' and provider_event_row is null and called_as is not null;
  if n <> 1 then raise exception 'FAIL P8a: the capture request is not attributed to the backend workflow (%)', n; end if;
  select count(*) into n from public.payment_financial_events
    where payment_id = pid and action = 'status_changed' and to_status = 'captured' and actor_kind = 'provider_event'
      and actor_label = 'provider:fixture' and provider_event_row is not null;
  if n <> 1 then raise exception 'FAIL P8b: the capture is not attributed to the provider event (%)', n; end if;

  -- P9: settlement is recorded once, by the provider's settlement event, and attributed to it.
  if pg_temp.ev('lc-p-1', 'lc-p-settle', 'settlement', 'captured', 1500000) <> 'applied' then
    raise exception 'FAIL P9a: provider settlement was not recorded';
  end if;
  if pg_temp.ev('lc-p-1', 'lc-p-settle-2', 'settlement', 'captured', 1500000) <> 'rejected' then
    raise exception 'FAIL P9b: a second settlement was accepted';
  end if;
  select count(*) into n from public.payment_financial_events
    where payment_id = pid and action = 'provider_settled' and actor_kind = 'provider_event' and provider_event_row is not null;
  if n <> 1 then raise exception 'FAIL P9c: settlement is not attributed to the provider event (%)', n; end if;

  -- P10: customers, support and operations cannot read the payment audit trails; finance can (reconciliation).
  foreach u in array array[owner, staff, ops] loop
    perform pg_temp.act_as(u, 'aal2');
    set local role authenticated;
    select count(*) into n from public.payment_provider_events;
    if n <> 0 then raise exception 'FAIL P10a: a non-finance user read % provider event(s)', n; end if;
    select count(*) into n from public.payment_financial_events;
    if n <> 0 then raise exception 'FAIL P10b: a non-finance user read % payment event(s)', n; end if;
    reset role;
  end loop;
  perform pg_temp.act_as(finance, 'aal2');
  set local role authenticated;
  select count(*) into n from public.payment_financial_events;
  if n < 3 then raise exception 'FAIL P10c: finance cannot read the payment audit trail'; end if;
  reset role;

  raise notice 'PASS P: capture is requested by the backend after verification, confirmed by the provider, and no signed-in user can change a payment';
end $$;

-- ---------------------------------------------------------------------------
-- Q. The provider-event boundary (docs/25, section 9): valid events apply once; invalid signatures, replays, duplicates,
--    stale events, illegal transitions and mismatched amounts change nothing; every attempt is recorded with its actor.
-- ---------------------------------------------------------------------------
do $$
declare
  owner uuid := '00000000-0000-0000-0000-0000000001a0';
  finance uuid := '00000000-0000-0000-0000-0000000000fa';
  admin uuid := '00000000-0000-0000-0000-0000000000ad';
  staff uuid := '00000000-0000-0000-0000-0000000000ee';
  ops uuid := '00000000-0000-0000-0000-0000000000b0';
  b1 uuid := '00000000-0000-0000-0000-000000000e01';
  b2 uuid := '00000000-0000-0000-0000-000000000e02';
  b3 uuid := '00000000-0000-0000-0000-000000000e03';
  b4 uuid := '00000000-0000-0000-0000-000000000e04';
  b5 uuid := '00000000-0000-0000-0000-000000000e05';
  u uuid;
  n integer;
  st text;
  res text;
begin
  perform pg_temp.act_as(null, null);
  perform pg_temp.make_ordered_booking(b1, owner);
  perform pg_temp.make_ordered_booking(b2, owner);
  perform pg_temp.make_ordered_booking(b3, owner);
  perform pg_temp.make_ordered_booking(b4, owner);
  perform pg_temp.make_ordered_booking(b5, owner);
  perform pg_temp.start_payment(b1, 'q-1', 1000);
  perform pg_temp.start_payment(b2, 'q-2', 1000);
  perform pg_temp.start_payment(b3, 'q-3', 1000);
  perform pg_temp.start_payment(b4, 'q-4', 1000);
  perform pg_temp.start_payment(b5, 'q-5', 1000);

  -- Q1: a valid webhook applies once, and is recorded as applied with its provider event ID, type and time.
  res := pg_temp.ev('q-1', 'q-ev-1', 'payment.authorised', 'authorised', 1000);
  if res <> 'applied' then raise exception 'FAIL Q1a: a valid webhook returned %', res; end if;
  select status into st from public.payments where provider_reference = 'q-1';
  if st <> 'authorised' then raise exception 'FAIL Q1b: a valid authorisation left the payment in %', st; end if;
  select count(*) into n from public.payment_provider_events
    where provider_event_id = 'q-ev-1' and processing_result = 'applied' and verification = 'webhook_signature'
      and event_type = 'payment.authorised' and occurred_at is not null and received_at is not null
      and actor_kind = 'provider_event' and actor_label = 'provider:fixture' and called_as is not null;
  if n <> 1 then raise exception 'FAIL Q1c: the applied event is not recorded with its ID, type, time and actor (%)', n; end if;

  -- Q2: an invalid signature is refused, recorded as rejected, and changes nothing.
  res := pg_temp.ev('q-2', 'q-ev-badsig', 'payment.authorised', 'authorised', 1000, 'none');
  if res <> 'rejected' then raise exception 'FAIL Q2a: an unverified event returned %', res; end if;
  select status into st from public.payments where provider_reference = 'q-2';
  if st <> 'initiated' then raise exception 'FAIL Q2b: an unverified event changed the payment to %', st; end if;
  select count(*) into n from public.payment_provider_events
    where provider_event_id = 'q-ev-badsig' and processing_result = 'rejected' and verification = 'none'
      and result_reason like '%not verified%';
  if n <> 1 then raise exception 'FAIL Q2c: the rejected event is not recorded (%)', n; end if;

  -- Q3: a replayed or duplicate event (the same provider event ID) changes nothing, and is recorded as duplicate.
  res := pg_temp.ev('q-1', 'q-ev-1', 'payment.authorised', 'authorised', 1000);
  if res <> 'duplicate' then raise exception 'FAIL Q3a: a replayed event returned %', res; end if;
  select status into st from public.payments where provider_reference = 'q-1';
  if st <> 'authorised' then raise exception 'FAIL Q3b: a replay changed the payment to %', st; end if;
  select count(*) into n from public.payment_provider_events where provider_event_id = 'q-ev-1' and processing_result = 'applied';
  if n <> 1 then raise exception 'FAIL Q3c: the event was applied % times', n; end if;
  select count(*) into n from public.payment_provider_events where provider_event_id = 'q-ev-1' and processing_result = 'duplicate';
  if n <> 1 then raise exception 'FAIL Q3d: the duplicate attempt is not recorded (%)', n; end if;

  -- Q4: an illegal transition is refused and recorded: authorised cannot become failed.
  res := pg_temp.ev('q-1', 'q-ev-fail', 'payment.failed', 'failed', 1000);
  if res <> 'rejected' then raise exception 'FAIL Q4a: an illegal transition returned %', res; end if;
  select status into st from public.payments where provider_reference = 'q-1';
  if st <> 'authorised' then raise exception 'FAIL Q4b: an illegal transition changed the payment to %', st; end if;

  -- Q5: a provider capture for a payment with no capture request goes to review, never to captured.
  res := pg_temp.ev('q-1', 'q-ev-cap-unrequested', 'payment.captured', 'captured', 1000);
  if res <> 'review_required' then raise exception 'FAIL Q5a: an unrequested capture returned %', res; end if;
  select status into st from public.payments where provider_reference = 'q-1';
  if st <> 'review_required' then raise exception 'FAIL Q5b: an unrequested capture left the payment in %', st; end if;

  -- Q6: an event for an unknown payment reference is rejected.
  res := pg_temp.ev('q-missing', 'q-ev-noref', 'payment.authorised', 'authorised', 1000);
  if res <> 'rejected' then raise exception 'FAIL Q6: an unknown reference returned %', res; end if;

  -- Q7: a malformed payload digest is rejected.
  res := pg_temp.ev('q-3', 'q-ev-baddigest', 'payment.authorised', 'authorised', 1000, 'webhook_signature', 'not-a-digest');
  if res <> 'rejected' then raise exception 'FAIL Q7: a malformed digest returned %', res; end if;

  -- Q8: a stale event (older than the last processed event for the payment) is refused.
  if pg_temp.ev('q-3', 'q-ev-q3-new', 'payment.authorised', 'authorised', 1000) <> 'applied' then
    raise exception 'FAIL Q8 setup: the current authorisation was not applied';
  end if;
  res := pg_temp.ev('q-3', 'q-ev-q3-stale', 'payment.released', 'released', 1000, 'webhook_signature', null, now() - interval '1 day');
  if res <> 'rejected' then raise exception 'FAIL Q8: a stale event returned %', res; end if;
  select status into st from public.payments where provider_reference = 'q-3';
  if st <> 'authorised' then raise exception 'FAIL Q8b: a stale event changed the payment to %', st; end if;

  -- Q9: a provider amount that differs from the payment goes to review, not to a state change.
  res := pg_temp.ev('q-4', 'q-ev-amount', 'payment.authorised', 'authorised', 999);
  if res <> 'review_required' then raise exception 'FAIL Q9a: a mismatched amount returned %', res; end if;
  select status into st from public.payments where provider_reference = 'q-4';
  if st <> 'review_required' then raise exception 'FAIL Q9b: a mismatched amount left the payment in %', st; end if;

  -- Q10: a pending report changes nothing and is recorded as no change.
  res := pg_temp.ev('q-5', 'q-ev-pending', 'payment.pending', 'pending', 1000);
  if res <> 'no_change' then raise exception 'FAIL Q10: a pending report returned %', res; end if;

  -- Q11: an event with an unknown provider state is rejected.
  res := pg_temp.ev('q-5', 'q-ev-badstate', 'payment.weird', 'weird', 1000);
  if res <> 'rejected' then raise exception 'FAIL Q11: an unknown provider state returned %', res; end if;

  -- Q12: no signed-in user, of any role, can apply an event or change a payment (no EXECUTE, no UPDATE).
  foreach u in array array[owner, staff, ops, finance, admin] loop
    perform pg_temp.act_as(u, 'aal2');
    set local role authenticated;
    begin
      perform public.apply_payment_provider_event('fixture', 'q12-user', 'payment.authorised', 'q-5', 'authorised',
        1000, 'NGN', now(), 'webhook_signature', repeat('d', 64));
      raise exception 'FAIL Q12a: a signed-in user applied a provider event';
    exception when insufficient_privilege then null; end;
    begin
      update public.payments set status = 'authorised' where provider_reference = 'q-5';
      raise exception 'FAIL Q12b: a signed-in user changed a payment';
    exception when insufficient_privilege then null; end;
    reset role;
  end loop;

  -- Q13: the provider-event audit trail is append-only and cannot be truncated, even by the owner.
  begin
    update public.payment_provider_events set result_reason = 'tampered';
    raise exception 'FAIL Q13a: a provider event record was changed';
  exception when check_violation then null; end;
  begin
    delete from public.payment_provider_events;
    raise exception 'FAIL Q13b: a provider event record was deleted';
  exception when check_violation then null; end;
  select count(*) into n from public.payment_provider_events where actor_kind <> 'provider_event';
  if n <> 0 then raise exception 'FAIL Q13c: a provider event has a non-provider actor'; end if;

  raise notice 'PASS Q: valid events apply once; invalid, replayed, duplicate, stale, illegal and mismatched events change nothing and are recorded';
end $$;

-- ---------------------------------------------------------------------------
-- N. Security of the SECURITY DEFINER functions, grants, identity, and shadowing (docs/25, section 6B).
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  owner uuid := '00000000-0000-0000-0000-0000000001a0';
  admin uuid := '00000000-0000-0000-0000-0000000000ad';
  finance uuid := '00000000-0000-0000-0000-0000000000fa';
  staff uuid := '00000000-0000-0000-0000-0000000000ee';
  d6 uuid := '00000000-0000-0000-0000-0000000002f6';
  rid uuid;
  fn text;
  trig_fns text[] := array[
    'public.guard_currency_bookable()', 'public.guard_booking_state()', 'public.guard_payment_capture()',
    'public.guard_partner_remittance()', 'public.audit_partner_remittance()', 'public.prevent_remittance_event_change()',
    'public.guard_payment_state()', 'public.prevent_payment_event_change()', 'public.payment_transition_allowed(text,text)',
    'public.booking_transition_allowed(text,text)', 'public.remittance_transition_allowed(text,text)',
    'public.booking_all_tickets_verified(uuid)', 'public.handle_new_user()', 'public.guard_profile_role()'];
begin
  -- N1: every SECURITY DEFINER function in public pins its search_path, with pg_temp last.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.prosecdef
    and not coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=public, pg_temp%';
  if n <> 0 then raise exception 'FAIL N1: % SECURITY DEFINER function(s) in public do not pin search_path', n; end if;

  -- N2: anon cannot execute any SECURITY DEFINER function in public.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE');
  if n <> 0 then raise exception 'FAIL N2: anon can execute % SECURITY DEFINER function(s) in public', n; end if;

  -- N3: trigger and internal helper functions are not executable by signed-in users or PUBLIC.
  foreach fn in array trig_fns loop
    if has_function_privilege('authenticated', fn, 'EXECUTE') then raise exception 'FAIL N3a: authenticated can execute %', fn; end if;
    if has_function_privilege('public', fn, 'EXECUTE') then raise exception 'FAIL N3b: PUBLIC can execute %', fn; end if;
  end loop;

  -- N4: signed-in and anonymous roles hold no TRUNCATE, TRIGGER or REFERENCES on the financial tables.
  foreach fn in array array['bookings', 'payments', 'tickets', 'partner_remittances', 'partner_remittance_events', 'payment_financial_events', 'payment_provider_events'] loop
    if has_table_privilege('authenticated', 'public.' || fn, 'TRUNCATE')
       or has_table_privilege('authenticated', 'public.' || fn, 'TRIGGER')
       or has_table_privilege('authenticated', 'public.' || fn, 'REFERENCES')
       or has_table_privilege('anon', 'public.' || fn, 'TRUNCATE')
       or has_table_privilege('anon', 'public.' || fn, 'TRIGGER')
       or has_table_privilege('anon', 'public.' || fn, 'REFERENCES') then
      raise exception 'FAIL N4: anon or authenticated holds TRUNCATE, TRIGGER or REFERENCES on %', fn;
    end if;
  end loop;

  -- N5: the audit trails cannot be written directly by any signed-in role.
  if has_table_privilege('authenticated', 'public.partner_remittance_events', 'INSERT')
     or has_table_privilege('authenticated', 'public.partner_remittance_events', 'UPDATE')
     or has_table_privilege('authenticated', 'public.partner_remittance_events', 'DELETE')
     or has_table_privilege('authenticated', 'public.payment_provider_events', 'INSERT')
     or has_table_privilege('authenticated', 'public.payment_provider_events', 'UPDATE')
     or has_table_privilege('authenticated', 'public.payment_provider_events', 'DELETE')
     or has_table_privilege('authenticated', 'public.payment_financial_events', 'INSERT')
     or has_table_privilege('authenticated', 'public.payment_financial_events', 'UPDATE')
     or has_table_privilege('authenticated', 'public.payment_financial_events', 'DELETE') then
    raise exception 'FAIL N5a: a signed-in role can write an audit trail directly';
  end if;

  -- N6: attribution cannot be rewritten after creation.
  perform pg_temp.make_ordered_booking(d6, owner);
  perform pg_temp.act_as(finance, 'aal2');
  insert into public.partner_remittances (booking_id, status, agreement_reference, agreement_clause, agreement_recorded_by,
    amount_minor, currency, due_at)
  values (d6, 'pending', 'PA-N', 'Clause N', finance, 500, 'NGN', now() + interval '2 days') returning id into rid;
  begin
    update public.partner_remittances set agreement_recorded_by = admin where id = rid;
    raise exception 'FAIL N6a: the recording user of an agreement was changed';
  exception when check_violation then null; end;
  begin
    update public.partner_remittances set agreement_recorded_at = now() - interval '1 year' where id = rid;
    raise exception 'FAIL N6b: the recording time was changed';
  exception when check_violation then null; end;
  begin
    update public.partner_remittances set created_at = now() - interval '1 year' where id = rid;
    raise exception 'FAIL N6c: the creation time was changed';
  exception when check_violation then null; end;
  begin
    update public.partner_remittances set id = gen_random_uuid() where id = rid;
    raise exception 'FAIL N6d: the record identifier was changed';
  exception when check_violation then null; end;

  -- N7: a remittance cannot be recorded in another user's name.
  begin
    insert into public.partner_remittances (booking_id, status, agreement_reference, agreement_clause, agreement_recorded_by,
      amount_minor, currency, due_at)
    values (d6, 'pending', 'PA-N2', 'Clause N2', admin, 1, 'NGN', now());
    raise exception 'FAIL N7: a remittance was recorded in another user''s name';
  exception when check_violation or unique_violation then null; end;

  -- N8: administrator identity needs the admin role AND a multi-factor session, checked in the trigger.
  perform pg_temp.act_as(admin, null);   -- an administrator without a multi-factor session
  begin
    update public.partner_remittances set status = 'under_review', status_reason = 'x' where id = rid;
    raise exception 'FAIL N8a: a remittance changed without a multi-factor session';
  exception when check_violation then null; end;
  perform pg_temp.act_as(finance, 'aal2');
  update public.partner_remittances set status = 'under_review', status_reason = 'Proof requested' where id = rid;
  perform pg_temp.act_as(finance, 'aal2');
  begin
    update public.partner_remittances set status = 'paid', payment_reference = 'TRF-N', paid_at = now() where id = rid;
    raise exception 'FAIL N8b: finance (not an administrator) marked a remittance paid';
  exception when check_violation then null; end;
  perform pg_temp.act_as(owner, 'aal2');  -- a customer with a multi-factor claim, but the customer role
  begin
    update public.partner_remittances set status = 'paid', payment_reference = 'TRF-N', paid_at = now() where id = rid;
    raise exception 'FAIL N8c: a customer marked a remittance paid';
  exception when check_violation then null; end;
  perform pg_temp.act_as(admin, 'aal2');
  update public.partner_remittances set status = 'paid', payment_reference = 'TRF-N', paid_at = now() where id = rid;

  raise notice 'PASS N1-N8: definer search paths pinned, no anon or signed-in execute on helpers, no table privileges for API roles, audit trails append-only, attribution immutable, administrator identity needs role and MFA';
end $$;

-- N9: a session-level function with the same name cannot take over the finance or administrator checks. Created at
-- top level, because the function bodies use dollar quoting.
create function pg_temp.current_app_role() returns text language sql as $$ select 'admin'::text $$;
create function pg_temp.is_admin_mfa() returns boolean language sql as $$ select true $$;
create function pg_temp.is_finance_mfa() returns boolean language sql as $$ select true $$;

do $$
declare
  staff uuid := '00000000-0000-0000-0000-0000000000ee';
  owner uuid := '00000000-0000-0000-0000-0000000001a0';
begin
  perform pg_temp.make_ordered_booking('00000000-0000-0000-0000-0000000002f9', owner);
  perform pg_temp.act_as(staff, 'aal2');
  begin
    insert into public.partner_remittances (booking_id, status, agreement_reference, agreement_clause, agreement_recorded_by,
      amount_minor, currency, due_at)
    values ('00000000-0000-0000-0000-0000000002f9', 'pending', 'PA-9', 'Clause 9', staff, 900, 'NGN', now() + interval '3 days');
    raise exception 'FAIL N9a: support staff created a remittance while a session function said finance';
  exception when check_violation or insufficient_privilege then null; end;
  raise notice 'PASS N9: a session-level function of the same name does not change the finance or administrator checks';
end $$;

rollback;
