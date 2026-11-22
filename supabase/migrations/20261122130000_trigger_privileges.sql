-- Phase 15: the MFA enforcement trigger function is called by the database, never through the API.
-- Supabase grants EXECUTE on new functions in public to PUBLIC by default, so this is revoked explicitly.
-- Triggers still run because trigger invocation does not need the caller to hold EXECUTE.

revoke execute on function public.require_verified_mfa_for_staff() from public, anon, authenticated;
