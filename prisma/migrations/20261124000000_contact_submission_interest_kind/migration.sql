-- =============================================================================
-- CMS phase 3d (batch C) — "register your interest" submissions in the
-- website Messages inbox. ADDITIVE ONLY: one new enum type and five new
-- columns on `contact_submissions`; nothing existing is altered or dropped.
--
-- The website's `interestForm` section submits through the Contact form's
-- own endpoint (`POST public/websites/:academyId/contact`, `kind:
-- 'interest'`), with the same throttle and honeypot, into the same table and
-- inbox. What an interest submission adds:
--   - `kind`: which form it came from. Every existing row, and every row the
--     Contact form writes, is `contact` (the column default). Adding a
--     column with a constant default is a metadata-only change on
--     PostgreSQL 11+ (no table rewrite).
--   - `phone_e164` / `phone_country`: the visitor's phone, normalised by the
--     server (both or neither, enforced below).
--   - `choice` / `choice_label`: the option the visitor picked and the
--     choice list's label, as the published section showed them.
-- An interest submission whose form asked for no email or message stores
-- '' in those existing NOT NULL columns, so they stay as they are.
--
-- RLS is unchanged: the public INSERT policy still ties a row to an academy
-- of the server-resolved organization; staff SELECT/UPDATE are unchanged.
-- Idempotent, so applying it twice is harmless.
--
-- Rollback (loses only the new columns' data):
--   ALTER TABLE "contact_submissions" DROP CONSTRAINT IF EXISTS "contact_submissions_phone_pair_check";
--   ALTER TABLE "contact_submissions" DROP COLUMN "kind", DROP COLUMN "phone_e164",
--     DROP COLUMN "phone_country", DROP COLUMN "choice", DROP COLUMN "choice_label";
--   DROP TYPE "contact_submission_kind";
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE "contact_submission_kind" AS ENUM ('contact', 'interest');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "contact_submissions"
  ADD COLUMN IF NOT EXISTS "kind" "contact_submission_kind" NOT NULL DEFAULT 'contact',
  ADD COLUMN IF NOT EXISTS "phone_e164" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "phone_country" VARCHAR(2),
  ADD COLUMN IF NOT EXISTS "choice" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "choice_label" VARCHAR(60);

DO $$ BEGIN
  ALTER TABLE "contact_submissions"
    ADD CONSTRAINT "contact_submissions_phone_pair_check"
    CHECK (("phone_e164" IS NULL) = ("phone_country" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
