-- ============================================================================
-- W4 (M4) — move the W4 remediation backup tables out of `public`.
--
-- M2 (20261104000310) wrote its rename mapping to `public.w4_backup_*`.
-- Prisma treats every unmodelled `public` table as drift, so any future
-- `prisma migrate diff` would propose `DROP TABLE` for them — and an
-- unreviewed diff would silently destroy the only record that makes the
-- rename reversible (the p44/p65 incident shape). The repository's
-- convention for migration backups (W8, 20261104000690) is the
-- `atlas_migration_backups` schema: outside Prisma's view and never readable
-- by the application role. Same tables, same rows, same privileges — only
-- the schema changes. Idempotent (a re-run, or a database where the tables
-- were never created, is a no-op).
--
-- Recovery SQL (docs/W4_UNIQUENESS_REMEDIATION.md §4) reads them from
-- `atlas_migration_backups`. Drop them after one release:
--   DROP TABLE atlas_migration_backups.w4_backup_organization_names,
--              atlas_migration_backups.w4_backup_academy_names,
--              atlas_migration_backups.w4_backup_academy_student_exemptions;
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS atlas_migration_backups;
REVOKE ALL ON SCHEMA atlas_migration_backups FROM PUBLIC;

ALTER TABLE IF EXISTS public."w4_backup_organization_names"
  SET SCHEMA atlas_migration_backups;
ALTER TABLE IF EXISTS public."w4_backup_academy_names"
  SET SCHEMA atlas_migration_backups;
ALTER TABLE IF EXISTS public."w4_backup_academy_student_exemptions"
  SET SCHEMA atlas_migration_backups;
