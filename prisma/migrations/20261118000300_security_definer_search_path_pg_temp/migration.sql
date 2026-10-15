-- Pre-merge security review (15 Oct 2026), finding L1 — every SECURITY
-- DEFINER function in `public` pins `search_path = public` but leaves the
-- temporary schema implicit. PostgreSQL then searches `pg_temp` FIRST, so a
-- session that can create temporary tables (the app role can) could shadow
-- a table these functions read (`users`, `organizations`, …) and change
-- what a definer-rights function sees. Exploiting it needs arbitrary SQL as
-- the app role, so it is defence in depth, not an open hole.
--
-- Fix: append `pg_temp` explicitly, which puts it LAST. Only the
-- function's own `search_path` setting changes; bodies, owners, grants and
-- volatility are untouched. Idempotent: functions already ending in
-- `pg_temp` are skipped. No data is read or written.
DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND 'search_path=public' = ANY (coalesce(p.proconfig, ARRAY[]::text[]))
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', fn);
  END LOOP;
END
$$;
