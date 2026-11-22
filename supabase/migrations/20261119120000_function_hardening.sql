-- Function privilege hardening, applied after 20261119000000_phase14_security.sql.
-- Supabase grants EXECUTE on functions in public to PUBLIC by default. The security-definer helpers
-- are called by RLS policies and must stay callable by signed-in roles only; trigger functions and the
-- audit trigger function must not be callable through the API at all.

-- Nothing in public is callable by anonymous requests.
revoke execute on all functions in schema public from anon;
revoke execute on all functions in schema public from public;

-- Trigger functions: called by the database, never by an API caller.
revoke execute on function public.handle_new_user() from authenticated;
revoke execute on function public.guard_profile_role() from authenticated;
revoke execute on function public.prevent_audit_mutation() from authenticated;

-- Helpers used by row level security policies. They reveal only the caller's own role and MFA state.
grant execute on function public.current_app_role() to authenticated;
grant execute on function public.is_staff_mfa() to authenticated;
grant execute on function public.is_admin_mfa() to authenticated;

-- The single staff path to passenger data stays callable by signed-in staff; it checks MFA and
-- assignment itself.
grant execute on function public.staff_passenger_details(uuid) to authenticated;

-- Fixed search path for the audit trigger function (Supabase lint 0011).
alter function public.prevent_audit_mutation() set search_path = public, pg_temp;
