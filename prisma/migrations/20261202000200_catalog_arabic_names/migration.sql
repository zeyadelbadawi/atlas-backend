-- B5 (UX audit) V21 / B8 V26 — Arabic names for the Platform-Owner-managed
-- catalog: add-ons and Atlas subscription payment methods.
--
-- ADDITIVE ONLY: four new NULLABLE text columns, no default, no data
-- change (metadata-only on PostgreSQL 11+, no table rewrite). The English
-- `name`/`display_name` and `description` stay required/as they are and are
-- the fallback wherever the Arabic one is empty.
--
-- RLS / grants: unchanged. `add_ons` and `payment_methods` are platform
-- catalogs with no RLS (P4/P12 precedent: every authenticated caller reads
-- the same catalog); the application role's existing table-level grants
-- cover new columns. Idempotent (IF NOT EXISTS).
--
-- Rollback (loses only the Arabic texts):
--   ALTER TABLE "add_ons" DROP COLUMN "name_ar", DROP COLUMN "description_ar";
--   ALTER TABLE "payment_methods" DROP COLUMN "display_name_ar", DROP COLUMN "description_ar";

ALTER TABLE "add_ons"
  ADD COLUMN IF NOT EXISTS "name_ar" TEXT,
  ADD COLUMN IF NOT EXISTS "description_ar" TEXT;

ALTER TABLE "payment_methods"
  ADD COLUMN IF NOT EXISTS "display_name_ar" TEXT,
  ADD COLUMN IF NOT EXISTS "description_ar" TEXT;
