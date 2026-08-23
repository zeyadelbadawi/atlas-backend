-- ============================================================================
-- P2 critical fix: RLS is inert against a superuser connection.
--
-- Discovered during P2 verification: `docker-compose.yml`'s `POSTGRES_USER`
-- (`atlas`) becomes the Postgres cluster's initial superuser (this is the
-- official `postgres` image's own behavior, not an Atlas choice). Every
-- migration up to this point — and P0/P1's entire application runtime —
-- has connected as that same superuser. Postgres row security is *never*
-- applied to superusers, under any circumstance, including tables with
-- `FORCE ROW LEVEL SECURITY` (FORCE only overrides the *table owner*
-- exemption — it has no effect on the superuser exemption, which is
-- absolute). Empirically verified with raw SQL before this fix: with
-- `app.current_organization_id` set to Organization A, a superuser
-- connection still read every organization's row, and reading with *no*
-- session variable set at all returned every row too, instead of none.
--
-- Fix: a second, deliberately unprivileged Postgres role for the
-- application's *runtime* connection only. Migrations continue running as
-- the superuser (`DATABASE_URL`, needed for DDL); `PrismaService` connects
-- as this new role instead (`APP_DATABASE_URL`, added this phase). Wrapped
-- in `DO $$ ... $$` blocks so this migration is idempotent/deterministic —
-- required by master plan §17 — and safe to reason about if ever re-run
-- against a database that already has the role.
--
-- Password note: this is a literal, dev/CI-only credential embedded in a
-- portable SQL migration (Postgres's `CREATE ROLE ... PASSWORD` syntax has
-- no way to read an environment variable). That is an acceptable trade-off
-- for local/CI databases seeded from scratch by this same migration, but
-- is explicitly NOT how a production credential should be provisioned —
-- production would create this role via infrastructure-as-code with a
-- secrets-manager-issued password (master plan §17 "environments... each a
-- genuinely separate database", §20 "secrets manager"), never a value
-- committed to source control. Flagged in the P2 final report.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'atlas_app') THEN
    CREATE ROLE "atlas_app"
      LOGIN
      PASSWORD 'atlas_app_dev_password'
      NOSUPERUSER
      NOBYPASSRLS
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION;
  END IF;
END
$$;

DO $$
DECLARE
  db_name text := current_database();
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO "atlas_app"', db_name);
END
$$;

GRANT USAGE ON SCHEMA public TO "atlas_app";

-- Present tables (schema_meta, users, refresh_tokens, password_reset_tokens,
-- organizations, organization_memberships as of this phase).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "atlas_app";

-- Every table any later phase's migration creates as the `atlas` superuser
-- automatically grants `atlas_app` the same access, with no migration in
-- that later phase needing to remember this step.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "atlas_app";
