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

-- Role changes are made by the service role (server code) or an admin.
select set_config('request.jwt.claim.role', 'service_role', false);
update public.profiles set role = 'support' where id = '00000000-0000-0000-0000-00000000000c';
select set_config('request.jwt.claim.role', '', false);

insert into public.bookings (id, user_id, display_currency, display_amount_minor) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'NGN', 1500000),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'NGN', 2200000);

do $$
declare
  n integer;
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
    update public.bookings set reservation_status = 'reservation_confirmed';
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

  -- 8. Support C sees all bookings.
  perform set_config('request.jwt.claim.sub', c::text, true);
  set local role authenticated;
  select count(*) into n from public.bookings;
  if n <> 2 then raise exception 'FAIL 8: support sees % bookings, expected 2', n; end if;
  -- ...but cannot change them.
  begin
    update public.bookings set reservation_status = 'reservation_confirmed';
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
     set reservation_status = 'reservation_confirmed', ticket_status = 'ticketing_pending'
   where id = '00000000-0000-0000-0000-0000000000a1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 10: service role update affected % rows', n; end if;
  reset role;

  -- 11. A ticket can never be recorded as issued against an unconfirmed reservation.
  begin
    update public.bookings
       set reservation_status = 'reservation_pending', ticket_status = 'ticketed'
     where id = '00000000-0000-0000-0000-0000000000b1';
    raise exception 'FAIL 11: ticketed booking accepted with pending reservation';
  exception when check_violation then
    null;
  end;

  -- 12. Ticketing cannot start on an unconfirmed reservation.
  begin
    update public.bookings
       set ticket_status = 'ticketing_pending'
     where id = '00000000-0000-0000-0000-0000000000b1';
    raise exception 'FAIL 12: ticketing started without a confirmed reservation';
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

  raise notice 'All RLS and constraint checks passed.';
end $$;
