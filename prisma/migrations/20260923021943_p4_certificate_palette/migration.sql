-- P4 Issue G — constrained, customisable certificate palette (4 roles).
-- Additive only. Defaults reproduce the original Atlas design exactly.
--
-- ORDERING NOTE: this migration's timestamp (2026-09-23) sorts BEFORE the
-- future-dated Phase 3 migrations (20261011…) that CREATE `certificate_templates`.
-- On an already-migrated database (production) it applied incrementally and is
-- recorded as applied. On a FRESH replay (CI, shadow, new environment) it runs
-- before the table exists, so it is written to be replay-order-tolerant:
-- `ALTER TABLE IF EXISTS` + `ADD COLUMN IF NOT EXISTS` make it a safe no-op
-- when the table is absent. The columns are then (re)ensured idempotently by
-- the correctly-ordered `20261012000001_p64_phase4_catalog_reviews` migration,
-- which runs after `certificate_templates` exists.
ALTER TABLE IF EXISTS "certificate_templates"
  ADD COLUMN IF NOT EXISTS "primary_color"    TEXT NOT NULL DEFAULT '#1F4E5F',
  ADD COLUMN IF NOT EXISTS "accent_color"     TEXT NOT NULL DEFAULT '#B08A3E',
  ADD COLUMN IF NOT EXISTS "text_color"       TEXT NOT NULL DEFAULT '#14303A',
  ADD COLUMN IF NOT EXISTS "background_color" TEXT NOT NULL DEFAULT '#FCFBF7';
