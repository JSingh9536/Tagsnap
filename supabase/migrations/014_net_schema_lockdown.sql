-- 014_net_schema_lockdown.sql
--
-- Security hardening (from the 2026-09-30 audit, finding #1).
--
-- Automation triggers use pg_net (the `net` schema) to POST to edge functions with the
-- service_role key as a bearer token. pg_net records every request and response -- including the
-- Authorization header -- in tables under the `net` schema. If default privileges on that schema
-- were ever left in place, a signed-in client role (anon / authenticated) could read the logged
-- service_role key back out via PostgREST or a direct connection and bypass every RLS policy.
--
-- This migration revokes all client-role access to the `net` schema. It is a no-op when the
-- extension/schema is absent, so it is safe to run on any environment.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') THEN
    REVOKE ALL ON SCHEMA net FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON ALL TABLES    IN SCHEMA net FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA net FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC, anon, authenticated;

    -- keep future objects in the schema locked down too
    ALTER DEFAULT PRIVILEGES IN SCHEMA net REVOKE ALL ON TABLES    FROM PUBLIC, anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA net REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA net REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;

    RAISE NOTICE 'net schema access revoked from anon/authenticated/PUBLIC';
  ELSE
    RAISE NOTICE 'net schema not present; nothing to revoke';
  END IF;
END
$$;
