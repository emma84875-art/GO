-- Row level security checks. Run after the shim and the migrations.
-- Raises an exception on the first failing check. Silent success means all pass.

\set ON_ERROR_STOP on

-- Fixed identifiers for three users and two bookings.
--   A: customer, owns booking A1
--   B: customer, owns booking B1
--   C: support staff
insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-00000000000b'),
  ('00000000-0000-0000-0000-00000000000c');

-- Phase 15 identities:
--   D: operations staff, verified MFA method
--   E: administrator, verified MFA method
--   F: no MFA method (must never receive a staff role)
insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000000d'),
  ('00000000-0000-0000-0000-00000000000e'),
  ('00000000-0000-0000-0000-00000000000f');
insert into auth.mfa_factors (user_id, status) values
  ('00000000-0000-0000-0000-00000000000c', 'verified'),
  ('00000000-0000-0000-0000-00000000000d', 'verified'),
  ('00000000-0000-0000-0000-00000000000e', 'verified');

-- Role changes are made by the service role (server code) or an admin.
select set_config('request.jwt.claim.role', 'service_role', false);
update public.profiles set role = 'support' where id = '00000000-0000-0000-0000-00000000000c';
update public.profiles set role = 'operations' where id = '00000000-0000-0000-0000-00000000000d';
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-00000000000e';
select set_config('request.jwt.claim.role', '', false);

insert into public.bookings (id, user_id, display_currency, display_amount_minor) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'NGN', 1500000),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'NGN', 2200000);

do $$
declare
  n integer;
  st text;
  a uuid := '00000000-0000-0000-0000-00000000000a';
  c uuid := '00000000-0000-0000-0000-00000000000c';
begin
  -- 1. Customer A sees only their own booking.
  perform set_config('request.jwt.claim.sub', a::text, true);
  set local role authenticated;
  select count(*) into n from public.bookings;
  if n <> 1 then raise exception 'FAIL 1: customer sees % bookings, expected 1', n; end if;
  reset role;

  -- 2. Customer A cannot change their own role.
  perform set_config('request.jwt.claim.sub', a::text, true);
  set local role authenticated;
  begin
    update public.profiles set role = 'admin' where id = a;
    raise exception 'FAIL 2: customer changed own role';
  exception when others then
    if sqlerrm not like '%Only an administrator%' then
      raise exception 'FAIL 2: unexpected error: %', sqlerrm;
    end if;
  end;
  reset role;

  -- 3. Customer A can update their own profile details.
  perform set_config('request.jwt.claim.sub', a::text, true);
  set local role authenticated;
  update public.profiles set full_name = 'Customer A' where id = a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 3: own profile update affected % rows', n; end if;
  reset role;

  -- 4. Customer A cannot change booking status directly.
  perform set_config('request.jwt.claim.sub', a::text, true);
  set local role authenticated;
  begin
    update public.bookings set booking_status = 'quoted';
    raise exception 'FAIL 4: customer updated a booking';
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  -- 5. Customer A cannot read the audit log.
  perform set_config('request.jwt.claim.sub', a::text, true);
  set local role authenticated;
  select count(*) into n from public.audit_log;
  if n <> 0 then raise exception 'FAIL 5: customer read % audit rows', n; end if;
  reset role;

  -- 6. Customer A cannot create a search on behalf of someone else.
  perform set_config('request.jwt.claim.sub', a::text, true);
  set local role authenticated;
  begin
    insert into public.searches (user_id, origin, destination, departure_date, passengers, cabin, display_currency)
    values ('00000000-0000-0000-0000-00000000000b', 'LOS', 'LHR', '2026-12-01', 1, 'economy', 'NGN');
    raise exception 'FAIL 6: customer created a search for another user';
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  -- 7. Customer A can record their own search.
  perform set_config('request.jwt.claim.sub', a::text, true);
  set local role authenticated;
  insert into public.searches (user_id, origin, destination, departure_date, passengers, cabin, display_currency)
  values (a, 'LOS', 'LHR', '2026-12-01', 1, 'economy', 'NGN');
  reset role;

  -- 8. Support C sees all bookings, but only in an MFA session (aal2).
  perform set_config('request.jwt.claim.sub', c::text, true);
  perform set_config('request.jwt.claims', '{}', true);
  set local role authenticated;
  select count(*) into n from public.bookings;
  if n <> 0 then raise exception 'FAIL 8a: staff without MFA sees % bookings', n; end if;
  reset role;
  perform set_config('request.jwt.claims', '{"aal":"aal2"}', true);
  set local role authenticated;
  select count(*) into n from public.bookings;
  if n <> 2 then raise exception 'FAIL 8: support sees % bookings, expected 2', n; end if;
  -- ...but cannot change them.
  begin
    update public.bookings set booking_status = 'quoted';
    raise exception 'FAIL 8b: support updated a booking';
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  -- 9. Anonymous users have no access at all.
  set local role anon;
  begin
    perform 1 from public.bookings;
    raise exception 'FAIL 9: anon read bookings';
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  -- 10. The service role (server code) can progress a booking through the lifecycle.
  set local role service_role;
  update public.bookings
     set booking_status = 'quoted', quoted_at = now()
   where id = '00000000-0000-0000-0000-0000000000a1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 10: service role update affected % rows', n; end if;
  reset role;

  -- 11. A booking cannot skip stages: tickets cannot be recorded as issued from draft.
  begin
    update public.bookings
       set booking_status = 'tickets_issued', tickets_issued_at = now()
     where id = '00000000-0000-0000-0000-0000000000b1';
    raise exception 'FAIL 11: tickets_issued accepted from draft';
  exception when check_violation then
    null;
  end;

  -- 12. Partner ticketing cannot start before the customer's payment is authorised.
  begin
    update public.bookings
       set booking_status = 'ticketing_pending'
     where id = '00000000-0000-0000-0000-0000000000b1';
    raise exception 'FAIL 12: partner ticketing started from draft';
  exception when check_violation then
    null;
  end;

  -- 13. The audit log accepts inserts but rejects updates and deletes, even for the service role.
  set local role service_role;
  insert into public.audit_log (actor_id, action, entity, entity_id)
  values (a, 'test.insert', 'bookings', '00000000-0000-0000-0000-0000000000a1');
  begin
    update public.audit_log set action = 'tampered';
    raise exception 'FAIL 13a: audit log row was updated';
  exception when others then
    if sqlerrm not like '%append only%' then raise exception 'FAIL 13a: unexpected error: %', sqlerrm; end if;
  end;
  begin
    delete from public.audit_log;
    raise exception 'FAIL 13b: audit log row was deleted';
  exception when others then
    if sqlerrm not like '%append only%' then raise exception 'FAIL 13b: unexpected error: %', sqlerrm; end if;
  end;
  reset role;

  -- 14. The audit log cannot be emptied with TRUNCATE, even by the service role (Phase 14).
  set local role service_role;
  begin
    truncate public.audit_log;
    raise exception 'FAIL 14: audit log was truncated';
  exception when others then
    if sqlerrm not like '%append only%' then raise exception 'FAIL 14: unexpected error: %', sqlerrm; end if;
  end;
  reset role;

  -- 15. A payment is created only as initiated. Every other state is reached through the payment functions (checked in
  -- supabase/tests/booking_lifecycle.sql), so no direct insert can create a captured or other financial state.
  set local role service_role;
  insert into public.payments (booking_id, provider, provider_reference, amount_minor, currency, status, reference, expires_at)
  values ('00000000-0000-0000-0000-0000000000a1', 'fixture', 'ref-initiated', 1500000, 'NGN', 'initiated', 'res-initiated', now() + interval '1 hour');
  -- Test cleanup only: the row above is removed with triggers off, as the owner. Payments are never deleted in
  -- production (payments_delete_guard, 20261130000000_payment_guards.sql).
  reset role;
  perform set_config('session_replication_role', 'replica', true);
  delete from public.payments where reference = 'res-initiated';
  perform set_config('session_replication_role', 'origin', true);
  set local role service_role;
  begin
    insert into public.payments (booking_id, provider, provider_reference, amount_minor, currency, status, reference, expires_at)
    values ('00000000-0000-0000-0000-0000000000a1', 'fixture', 'ref-bad', 1, 'NGN', 'succeeded', 'res-bad', now() + interval '1 hour');
    raise exception 'FAIL 15: an unknown payment status was accepted';
  exception when check_violation then
    null;
  end;
  reset role;

  -- 16. One live payment per booking, enforced by the database. A failed attempt is not live.
  -- Provider events come from the backend: no signed-in user is present when they are applied.
  set local role service_role;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.payments (booking_id, provider, provider_reference, amount_minor, currency, status, reference, expires_at)
  values ('00000000-0000-0000-0000-0000000000a1', 'fixture', 'ref-failed', 1500000, 'NGN', 'initiated', 'res-failed', now() + interval '1 hour');
  if public.apply_payment_provider_event('fixture', 'rls-failed-1', 'payment.failed', 'ref-failed', 'failed',
       1500000, 'NGN', now(), 'webhook_signature', repeat('b', 64)) <> 'applied' then
    raise exception 'FAIL 16: the provider failure was not applied';
  end if;
  insert into public.payments (booking_id, provider, provider_reference, amount_minor, currency, status, reference, expires_at)
  values ('00000000-0000-0000-0000-0000000000a1', 'fixture', 'ref-live-1', 1500000, 'NGN', 'initiated', 'res-live-1', now() + interval '1 hour');
  if public.apply_payment_provider_event('fixture', 'rls-live-1', 'payment.authorised', 'ref-live-1', 'authorised',
       1500000, 'NGN', now(), 'webhook_signature', repeat('a', 64)) <> 'applied' then
    raise exception 'FAIL 16: the provider authorisation was not applied';
  end if;
  begin
    insert into public.payments (booking_id, provider, provider_reference, amount_minor, currency, status, reference, expires_at)
    values ('00000000-0000-0000-0000-0000000000a1', 'fixture', 'ref-live-2', 1500000, 'NGN', 'initiated', 'res-live-2', now() + interval '1 hour');
    raise exception 'FAIL 16a: a second live payment for one booking was accepted';
  exception when unique_violation then
    null;
  end;
  begin
    insert into public.payments (booking_id, provider, provider_reference, amount_minor, currency, status, reference, expires_at)
    values ('00000000-0000-0000-0000-0000000000a1', 'fixture', 'ref-reuse', 1500000, 'NGN', 'initiated', 'res-live-1', now() + interval '1 hour');
    raise exception 'FAIL 16b: a reused payment reference was accepted';
  exception when unique_violation then
    null;
  end;
  reset role;

  -- 17. Webhook events are deduplicated durably; no client role can read or write them.
  set local role service_role;
  insert into public.payment_webhook_events (provider, dedupe_key) values ('fixture', 'evt-1');
  begin
    insert into public.payment_webhook_events (provider, dedupe_key) values ('fixture', 'evt-1');
    raise exception 'FAIL 17a: a duplicate webhook event was accepted';
  exception when unique_violation then
    null;
  end;
  reset role;
  set local role authenticated;
  begin
    perform 1 from public.payment_webhook_events;
    raise exception 'FAIL 17b: an authenticated user read webhook events';
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  -- 18. Ticket numbers are never stored in plain text; duplicates are detected by hash.
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'tickets' and column_name = 'ticket_number') then
    raise exception 'FAIL 18a: a plaintext ticket_number column exists';
  end if;
  set local role service_role;
  insert into public.passengers (id, booking_id, first_name, last_name, date_of_birth, nationality)
  values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'Ada', 'Okafor', '1990-05-14', 'NG');
  insert into public.tickets (booking_id, passenger_id, ticket_number_ciphertext, ticket_number_key_id, ticket_number_hash)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', 'v1.k1.iv.tag.ct', 'k1', repeat('a', 64));
  begin
    insert into public.tickets (booking_id, passenger_id, ticket_number_ciphertext, ticket_number_key_id, ticket_number_hash)
    values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', 'v1.k1.iv2.tag2.ct2', 'k1', repeat('a', 64));
    raise exception 'FAIL 18b: a duplicate ticket hash was accepted';
  exception when unique_violation then
    null;
  end;
  begin
    insert into public.tickets (booking_id, passenger_id, ticket_number_ciphertext, ticket_number_key_id, ticket_number_hash)
    values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', 'plain-123456', 'k1', repeat('b', 64));
    raise exception 'FAIL 18c: a ticket without ciphertext format was accepted';
  exception when check_violation then
    null;
  end;
  reset role;

  -- 19. Passengers: assignment-based staff access, MFA required, every read logged.
  -- 19a. Staff with MFA but no assignment cannot read passengers directly or through the function.
  perform set_config('request.jwt.claim.sub', c::text, true);
  perform set_config('request.jwt.claims', '{"aal":"aal2"}', true);
  set local role authenticated;
  select count(*) into n from public.passengers;
  if n <> 0 then raise exception 'FAIL 19a: staff read passengers directly (%)', n; end if;
  begin
    select count(*) into n from public.staff_passenger_details('00000000-0000-0000-0000-0000000000a1');
    raise exception 'FAIL 19b: unassigned staff read passengers through the function';
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  -- 19c. Assignment created by server code. Assigned staff read through the function; the read is logged.
  set local role service_role;
  insert into public.support_assignments (booking_id, staff_id, assigned_by)
  values ('00000000-0000-0000-0000-0000000000a1', c, a);
  reset role;
  perform set_config('request.jwt.claim.sub', c::text, true);
  perform set_config('request.jwt.claims', '{"aal":"aal2"}', true);
  set local role authenticated;
  select count(*) into n from public.staff_passenger_details('00000000-0000-0000-0000-0000000000a1');
  if n <> 1 then raise exception 'FAIL 19c: assigned staff got % passengers, expected 1', n; end if;
  reset role;
  select count(*) into n from public.passenger_access_log where staff_id = c and booking_id = '00000000-0000-0000-0000-0000000000a1';
  if n <> 1 then raise exception 'FAIL 19d: the passenger read was not logged (% rows)', n; end if;

  -- 19e. Assigned staff without MFA are refused.
  perform set_config('request.jwt.claims', '{}', true);
  set local role authenticated;
  begin
    select count(*) into n from public.staff_passenger_details('00000000-0000-0000-0000-0000000000a1');
    raise exception 'FAIL 19e: staff without MFA read passengers';
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  -- 19f. A customer cannot use the staff function, even with an MFA claim.
  perform set_config('request.jwt.claim.sub', a::text, true);
  perform set_config('request.jwt.claims', '{"aal":"aal2"}', true);
  set local role authenticated;
  begin
    select count(*) into n from public.staff_passenger_details('00000000-0000-0000-0000-0000000000a1');
    raise exception 'FAIL 19f: a customer used the staff function';
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  -- 19g. The access log is append-only and not readable by a customer or by unassigned staff.
  set local role service_role;
  begin
    update public.passenger_access_log set fields = '{}';
    raise exception 'FAIL 19g: the passenger access log was updated';
  exception when others then
    if sqlerrm not like '%append only%' then raise exception 'FAIL 19g: unexpected error: %', sqlerrm; end if;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', a::text, true);
  perform set_config('request.jwt.claims', '{"aal":"aal2"}', true);
  set local role authenticated;
  select count(*) into n from public.passenger_access_log;
  if n <> 0 then raise exception 'FAIL 19h: a customer read the passenger access log (% rows)', n; end if;
  reset role;

  -- 20. Staff roles and MFA enforcement (phase 15).
  -- 20a. A staff role cannot be granted to an account without a verified MFA method.
  insert into auth.users (id) values ('00000000-0000-0000-0000-000000000099');
  perform set_config('request.jwt.claim.role', 'service_role', true);
  set local role service_role;
  begin
    update public.profiles set role = 'support' where id = '00000000-0000-0000-0000-000000000099';
    raise exception 'FAIL 20a: a staff role was granted without MFA';
  exception when others then
    if sqlerrm not like '%verified multi-factor method%' then
      raise exception 'FAIL 20a: unexpected error: %', sqlerrm;
    end if;
  end;
  -- 20b. Roles outside the list are rejected by the database.
  begin
    update public.profiles set role = 'root' where id = a;
    raise exception 'FAIL 20b: an unknown role was accepted';
  exception when check_violation then
    null;
  end;
  reset role;
  perform set_config('request.jwt.claim.role', '', true);

  -- 21. Operations (D) read bookings in an MFA session only, and never passenger details.
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', true);
  perform set_config('request.jwt.claims', '{}', true);
  set local role authenticated;
  select count(*) into n from public.bookings;
  if n <> 0 then raise exception 'FAIL 21a: operations without MFA sees % bookings', n; end if;
  reset role;
  perform set_config('request.jwt.claims', '{"aal":"aal2"}', true);
  set local role authenticated;
  select count(*) into n from public.bookings;
  if n <> 2 then raise exception 'FAIL 21b: operations sees % bookings, expected 2', n; end if;
  select count(*) into n from public.passengers;
  if n <> 0 then raise exception 'FAIL 21c: operations read passengers directly (%)', n; end if;
  begin
    select count(*) into n from public.staff_passenger_details('00000000-0000-0000-0000-0000000000a1');
    raise exception 'FAIL 21d: operations read passengers through the function';
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  -- 22. Role escalation attempts.
  -- 22a. Support (C) cannot promote themselves to administrator, even in an MFA session.
  perform set_config('request.jwt.claim.sub', c::text, true);
  set local role authenticated;
  begin
    update public.profiles set role = 'admin' where id = c;
    raise exception 'FAIL 22a: support promoted themselves';
  exception when others then
    if sqlerrm not like '%Only an administrator%' then raise exception 'FAIL 22a: unexpected error: %', sqlerrm; end if;
  end;
  reset role;
  -- 22b. Operations (D) cannot promote themselves to support.
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', true);
  perform set_config('request.jwt.claims', '{"aal":"aal2"}', true);
  set local role authenticated;
  begin
    update public.profiles set role = 'support' where id = '00000000-0000-0000-0000-00000000000d';
    raise exception 'FAIL 22b: operations promoted themselves';
  exception when others then
    if sqlerrm not like '%Only an administrator%' then raise exception 'FAIL 22b: unexpected error: %', sqlerrm; end if;
  end;
  reset role;
  -- 22c. An administrator without an MFA session cannot change roles.
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000e', true);
  perform set_config('request.jwt.claims', '{}', true);
  set local role authenticated;
  begin
    update public.profiles set role = 'customer' where id = '00000000-0000-0000-0000-00000000000e';
    raise exception 'FAIL 22c: an administrator without MFA changed a role';
  exception when others then
    if sqlerrm not like '%Only an administrator%' then raise exception 'FAIL 22c: unexpected error: %', sqlerrm; end if;
  end;
  reset role;
  -- 22d. Even an administrator in an MFA session cannot change another user's role directly (RLS:
  -- profiles can be updated only by their owner). Role changes go through the logged server path.
  perform set_config('request.jwt.claims', '{"aal":"aal2"}', true);
  set local role authenticated;
  update public.profiles set role = 'customer' where id = a;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 22d: an administrator changed another user''s role directly'; end if;
  reset role;

  perform set_config('request.jwt.claims', '{}', true);
  raise notice 'All RLS and constraint checks passed.';
end $$;

-- Phase 15 (owner decision 3): super administrators and staff MFA resets.
-- Identities: E and G are super administrators. D (operations) and C (support) are staff.
-- H is a support account with no factor. The requester, verifier and completer must all differ.
do $$
declare
  rid uuid;
  rid2 uuid;
  n integer;
  a uuid := '00000000-0000-0000-0000-00000000000a';
  c uuid := '00000000-0000-0000-0000-00000000000c';
  d uuid := '00000000-0000-0000-0000-00000000000d';
  e uuid := '00000000-0000-0000-0000-00000000000e';
  g uuid := '00000000-0000-0000-0000-000000000007';
  h uuid := '00000000-0000-0000-0000-000000000008';
begin
  -- Setup: G is a second administrator with a verified factor. E and G are designated.
  insert into auth.users (id) values (g), (h);
  insert into auth.mfa_factors (user_id, status) values (g, 'verified'), (h, 'verified');
  perform set_config('request.jwt.claim.role', 'service_role', true);
  update public.profiles set role = 'admin' where id = g;
  update public.profiles set role = 'support' where id = h;
  insert into public.super_administrators (user_id, designated_by) values (e, 'test-setup'), (g, 'test-setup');
  perform set_config('request.jwt.claim.role', '', true);

  -- 30a. Operations cannot start a reset.
  perform set_config('request.jwt.claim.sub', d::text, true);
  perform set_config('request.jwt.claims', '{"aal":"aal2"}', true);
  set local role authenticated;
  begin
    perform public.request_staff_mfa_reset(c, 'Lost authenticator device, identity to be confirmed');
    raise exception 'FAIL 30a: operations started a reset';
  exception when others then
    if sqlerrm not like '%super administrator%' then raise exception 'FAIL 30a: unexpected error: %', sqlerrm; end if;
  end;
  reset role;

  -- 30b. A customer cannot start a reset.
  perform set_config('request.jwt.claim.sub', a::text, true);
  set local role authenticated;
  begin
    perform public.request_staff_mfa_reset(c, 'Lost authenticator device, identity to be confirmed');
    raise exception 'FAIL 30b: a customer started a reset';
  exception when others then
    if sqlerrm not like '%super administrator%' then raise exception 'FAIL 30b: unexpected error: %', sqlerrm; end if;
  end;
  reset role;

  -- 30c. A super administrator cannot reset their own factor.
  perform set_config('request.jwt.claim.sub', e::text, true);
  perform set_config('request.jwt.claims', '{"aal":"aal2"}', true);
  set local role authenticated;
  begin
    perform public.request_staff_mfa_reset(e, 'Lost authenticator device, identity to be confirmed');
    raise exception 'FAIL 30c: a super administrator reset their own factor';
  exception when others then
    if sqlerrm not like '%own multi-factor%' then raise exception 'FAIL 30c: unexpected error: %', sqlerrm; end if;
  end;
  reset role;

  -- 30d. A super administrator cannot be the target of a staff reset.
  set local role authenticated;
  begin
    perform public.request_staff_mfa_reset(g, 'Lost authenticator device, identity to be confirmed');
    raise exception 'FAIL 30d: a super administrator was the target of a staff reset';
  exception when others then
    if sqlerrm not like '%separate procedure%' then raise exception 'FAIL 30d: unexpected error: %', sqlerrm; end if;
  end;
  reset role;

  -- 30e. A short documented reason is refused by the database.
  set local role authenticated;
  begin
    perform public.request_staff_mfa_reset(c, 'too short');
    raise exception 'FAIL 30e: a reset with a short reason was accepted';
  exception when check_violation then
    null;
  end;
  reset role;

  -- 30f. A valid request is recorded and audited.
  set local role authenticated;
  select public.request_staff_mfa_reset(c, 'Lost authenticator device, identity to be confirmed') into rid;
  reset role;
  if rid is null then raise exception 'FAIL 30f: no reset was recorded'; end if;

  -- 30g. The requester cannot verify the identity.
  set local role authenticated;
  begin
    perform public.verify_staff_mfa_reset_identity(rid, 'in_person');
    raise exception 'FAIL 30g: the requester verified their own request';
  exception when others then
    if sqlerrm not like '%requesting super administrator cannot verify%' then raise exception 'FAIL 30g: unexpected error: %', sqlerrm; end if;
  end;
  reset role;

  -- 30h. A different super administrator records the identity check.
  perform set_config('request.jwt.claim.sub', g::text, true);
  set local role authenticated;
  perform public.verify_staff_mfa_reset_identity(rid, 'callback_to_registered_number');
  reset role;
  select count(*) into n from public.staff_mfa_resets where id = rid and identity_verified_by = g and identity_verified_at is not null;
  if n <> 1 then raise exception 'FAIL 30h: the identity check was not recorded'; end if;

  -- 30i. Completion is refused until the staff member has been notified.
  set local role authenticated;
  begin
    perform public.complete_staff_mfa_reset(rid);
    raise exception 'FAIL 30i: completed before notice';
  exception when others then
    if sqlerrm not like '%must be notified first%' then raise exception 'FAIL 30i: unexpected error: %', sqlerrm; end if;
  end;
  reset role;

  -- 30j. The server records the notice (service role).
  perform set_config('request.jwt.claim.role', 'service_role', true);
  set local role service_role;
  update public.staff_mfa_resets set target_notified_at = now() where id = rid;
  reset role;
  perform set_config('request.jwt.claim.role', '', true);

  -- 30k. The requester cannot complete their own reset.
  perform set_config('request.jwt.claim.sub', e::text, true);
  set local role authenticated;
  begin
    perform public.complete_staff_mfa_reset(rid);
    raise exception 'FAIL 30k: the requester completed the reset';
  exception when others then
    if sqlerrm not like '%requesting super administrator cannot complete%' then raise exception 'FAIL 30k: unexpected error: %', sqlerrm; end if;
  end;
  reset role;

  -- 30l. A third party completes it.
  perform set_config('request.jwt.claim.sub', g::text, true);
  set local role authenticated;
  perform public.complete_staff_mfa_reset(rid);
  reset role;
  select count(*) into n from public.staff_mfa_resets where id = rid and completed_by = g and completed_at is not null;
  if n <> 1 then raise exception 'FAIL 30l: completion was not recorded'; end if;

  -- 30m. Every step is in the audit log.
  select count(*) into n from public.audit_log where entity = 'staff_mfa_reset' and entity_id = rid::text;
  if n <> 3 then raise exception 'FAIL 30m: expected 3 audit entries for the reset, found %', n; end if;

  -- 30n. A closed reset cannot be cancelled.
  perform set_config('request.jwt.claim.sub', e::text, true);
  set local role authenticated;
  begin
    perform public.cancel_staff_mfa_reset(rid);
    raise exception 'FAIL 30n: a closed reset was cancelled';
  exception when others then
    if sqlerrm not like '%No open reset%' then raise exception 'FAIL 30n: unexpected error: %', sqlerrm; end if;
  end;
  reset role;

  -- 30o. An open reset can be cancelled by an active super administrator.
  set local role authenticated;
  select public.request_staff_mfa_reset(d, 'Device replaced, identity to be confirmed by callback') into rid2;
  perform public.cancel_staff_mfa_reset(rid2);
  reset role;
  select count(*) into n from public.staff_mfa_resets where id = rid2 and cancelled_at is not null;
  if n <> 1 then raise exception 'FAIL 30o: the open reset was not cancelled'; end if;

  -- 30p. Staff cannot read reset records; a super administrator can.
  perform set_config('request.jwt.claim.sub', c::text, true);
  perform set_config('request.jwt.claims', '{"aal":"aal2"}', true);
  set local role authenticated;
  select count(*) into n from public.staff_mfa_resets;
  if n <> 0 then raise exception 'FAIL 30p: a support member read reset records (%)', n; end if;
  reset role;
  perform set_config('request.jwt.claim.sub', e::text, true);
  set local role authenticated;
  select count(*) into n from public.staff_mfa_resets;
  if n <> 2 then raise exception 'FAIL 30p: a super administrator saw % reset records, expected 2', n; end if;
  reset role;

  -- 31. Designation rules.
  -- 31a. Someone who is not an administrator cannot be designated.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  begin
    insert into public.super_administrators (user_id, designated_by) values (h, 'test-setup');
    raise exception 'FAIL 31a: a support member was designated super administrator';
  exception when others then
    if sqlerrm not like '%Only an administrator%' then raise exception 'FAIL 31a: unexpected error: %', sqlerrm; end if;
  end;
  -- 31b. Revoking E would leave one super administrator, so it is refused.
  begin
    update public.super_administrators set revoked_at = now() where user_id = e;
    raise exception 'FAIL 31b: the last-but-one super administrator was revoked';
  exception when others then
    if sqlerrm not like '%At least two%' then raise exception 'FAIL 31b: unexpected error: %', sqlerrm; end if;
  end;
  perform set_config('request.jwt.claim.role', '', true);

  raise notice 'Phase 15 checks passed: super administrators and staff MFA resets.';
end $$;
