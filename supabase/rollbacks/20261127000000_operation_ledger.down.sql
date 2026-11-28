-- Rollback for supabase/migrations/20261127000000_operation_ledger.sql (Phase 19.2).
-- Not applied automatically. Run by hand, or by scripts/test-db.sh for the round-trip check.
--
-- It refuses to run, and changes nothing, if any operation has been recorded. The ledger is the only record that a
-- supplier order, a supplier cancellation or a provider capture request was sent. Dropping it would lose that record,
-- and a retry could then send the same effect twice. Operations recorded in the ledger must be reconciled and kept.
-- The only exception is a database that never ran an operation through the ledger.
--
-- Order matters: this runs before the Phase 19.1 rollback, which cannot drop bookings while the ledger references them.

begin;

do $$
declare
  n bigint;
begin
  select count(*) into n from public.operation_ledger;
  if n > 0 then
    raise exception 'Rollback stopped: % operation(s) are recorded in the operation ledger. Nothing was changed.', n;
  end if;
end $$;

drop table public.operation_attempts;
drop table public.operation_ledger;

drop function public.begin_operation(text, text, uuid, text, text, text, text, text, integer);
drop function public.complete_operation(uuid, text, text, text, text, text);
drop function public.renew_operation_lease(uuid, text, integer);
drop function public.reconcile_operation(uuid, text, text, text, text, text, text);
drop function public.guard_operation_ledger();
drop function public.prevent_operation_change();
drop function public.operation_transition_allowed(text, text);

commit;
