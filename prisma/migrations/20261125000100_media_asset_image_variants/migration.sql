-- =============================================================================
-- CMS phase 4 — responsive image variants. ADDITIVE ONLY: one nullable
-- column on `media_assets`; nothing existing is altered or dropped.
--
-- `variants` lists the AVIF/WebP copies the media worker stored next to a
-- public raster image (`[{width, height, format, sizeBytes}]`); their object
-- keys are derived from `storage_key`, never stored. NULL = none generated
-- yet: every existing row, which the public media route keeps serving as
-- the original until the backfill (`dist/scripts/backfill-image-variants.js`)
-- has run. A nullable column with no default is a metadata-only change.
--
-- RLS is unchanged (the column is covered by the existing row policies).
-- Idempotent, so applying it twice is harmless.
--
-- Rollback (the stored variant objects stay in the bucket, unreferenced):
--   ALTER TABLE "media_assets" DROP COLUMN IF EXISTS "variants";
-- =============================================================================

ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "variants" JSONB;
