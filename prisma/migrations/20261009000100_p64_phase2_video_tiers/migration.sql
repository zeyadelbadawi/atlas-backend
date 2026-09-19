-- ============================================================================
-- P64 Phase 2 — two plan families, two video security tiers
-- (master plan D10, D11, AD-15, AD-16; Decision Log DL-18 … DL-24).
--
-- WHY THIS IS A SECOND MIGRATION RATHER THAN AN EDIT TO THE FIRST
--
-- `20261009000000` is not yet applied to production, so folding these
-- columns into it would be technically possible. It is deliberately not
-- done: that migration is already applied to every developer database and
-- to CI, and silently changing an applied migration's contents is how a
-- checksum mismatch turns into a broken environment for everyone else.
-- Phase 1 shipped eight migrations for the same reason.
--
-- WHAT THIS ADDS
--
--   1. Plan families and tiers — the six commercial variants, modelled as
--      two independent axes rather than six duplicated rule sets.
--   2. `r2_worker` — the NORMAL video delivery path.
--   3. `media_assets.security_tier` — what Atlas PROMISED for an asset, as
--      distinct from `provider`, which is where its bytes are (AD-15).
--   4. Duration provenance — because the quota is denominated in minutes,
--      so "who said this video is 12 minutes long" is a billing question.
--   5. The academy's DEFAULT upload tier.
--   6. Tier and provider on `content_access_log`, because Normal and
--      Premium assets coexist in one academy (D11) and the forensic
--      question "was this delivered under the protection we sold?" has to
--      be answerable.
--
-- EVERY COLUMN IS NULLABLE OR DEFAULTED to the behaviour the existing rows
-- already have, so the previous image keeps running against this schema.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Enum types
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "plan_family" AS ENUM ('normal', 'premium');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "plan_tier" AS ENUM ('basic', 'growth', 'enterprise');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "video_security_tier" AS ENUM ('normal', 'premium');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "video_duration_source" AS ENUM ('measured', 'parsed', 'declared');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The NORMAL tier's delivery path. A distinct value from `r2` because the
-- enforced capabilities genuinely differ: a presigned URL is bound to time
-- alone, while the Worker gate re-authorizes every request and can revoke
-- before expiry. Recording them as the same provider would make the
-- capability report a guess.
--
-- `ADD VALUE` is not used anywhere in this migration, which is what keeps
-- it safe inside Prisma's transaction (PostgreSQL forbids USING a new enum
-- value in the transaction that added it).
ALTER TYPE "media_asset_provider" ADD VALUE IF NOT EXISTS 'r2_worker';


-- ---------------------------------------------------------------------------
-- 2. plans — the two commercial axes (D10)
--
-- `key` stays the unique identity; subscriptions reference it and renaming
-- it would break every existing row for no product benefit (DL-17). These
-- columns DESCRIBE a plan rather than replacing its key, which is what
-- lets the catalog answer "what does PREMIUM_GROWTH entitle?" without six
-- copies of the same business logic.
-- ---------------------------------------------------------------------------
ALTER TABLE "plans"
  ADD COLUMN IF NOT EXISTS "family" "plan_family" NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS "tier" "plan_tier" NOT NULL DEFAULT 'basic';

-- Backfill from the key each row already has. Every existing plan is
-- `normal`: the premium family does not exist yet, so claiming any
-- existing customer is on it would be an invention. `starter` is the key
-- D10's vocabulary calls `basic`.
UPDATE "plans"
SET "tier" = CASE
      WHEN "key" = 'growth'     THEN 'growth'::"plan_tier"
      WHEN "key" = 'enterprise' THEN 'enterprise'::"plan_tier"
      ELSE 'basic'::"plan_tier"
    END
WHERE "tier" = 'basic';

CREATE INDEX IF NOT EXISTS "plans_family_tier_idx" ON "plans"("family", "tier");


-- ---------------------------------------------------------------------------
-- 3. media_assets — what was promised, and where the duration came from
--
-- Both nullable: a security TIER is a hosted-video concept, and claiming
-- one for a PDF or a logo would be meaningless. Existing video rows are
-- backfilled below from the provider they actually have, which is the only
-- honest source — the academy's current plan says nothing about what an
-- asset created months ago was promised (D11).
-- ---------------------------------------------------------------------------
ALTER TABLE "media_assets"
  ADD COLUMN IF NOT EXISTS "security_tier" "video_security_tier",
  ADD COLUMN IF NOT EXISTS "duration_source" "video_duration_source";

UPDATE "media_assets"
SET "security_tier" = 'premium'::"video_security_tier"
WHERE "provider" = 'cloudflare_stream' AND "security_tier" IS NULL;

CREATE INDEX IF NOT EXISTS "media_assets_academy_id_security_tier_idx"
  ON "media_assets"("academy_id", "security_tier");


-- ---------------------------------------------------------------------------
-- 4. academies — the DEFAULT tier for new uploads (D10/D11)
--
-- A default for the future, never a statement about the past. Null means
-- "whatever the plan entitles", which is correct for every academy that
-- has never chosen — and is what keeps a plan change from silently
-- rewriting an academy's stated preference.
-- ---------------------------------------------------------------------------
ALTER TABLE "academies"
  ADD COLUMN IF NOT EXISTS "video_security_tier" "video_security_tier";


-- ---------------------------------------------------------------------------
-- 5. content_access_log — tier and provider (D10)
--
-- Nullable because a refusal frequently never reaches an asset at all
-- (`notEnrolled`, `deviceLimit`), and because text lessons have no
-- provider. Recording a tier for those would be fabrication.
-- ---------------------------------------------------------------------------
ALTER TABLE "content_access_log"
  ADD COLUMN IF NOT EXISTS "security_tier" "video_security_tier",
  ADD COLUMN IF NOT EXISTS "provider" "media_asset_provider";
