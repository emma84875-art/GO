-- Rollback for supabase/migrations/20261129000000_payment_authority.sql (Phase 19.2, payment authority).
-- Drops only the four functions. No table, row or 19.1 rule is changed, so it is safe at any time.
begin;
drop function public.app_payment_find_by_reference(text);
drop function public.app_payment_load(uuid);
drop function public.app_payment_bind_reference(uuid, text);
drop function public.app_payment_start(uuid, text, text, bigint, char, timestamptz);
commit;
