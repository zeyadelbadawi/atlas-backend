-- G1 — season capacity plan + CAC per channel, managed from the Platform
-- Owner dashboard (`/dashboard/platform/growth`).
--
--   * acquisition_channel            the closed channel vocabulary.
--   * organizations / platform_contact_submissions
--       .heard_from, .heard_from_other
--                                    the visitor's own "how did you first
--                                    hear about us?" answer (voluntary; not
--                                    tracking, so not gated by the
--                                    attribution flag).
--   * organization_platform_flags
--       .acquisition_channel_override, .acquisition_override_note
--                                    the Platform Owner's manual channel for
--                                    founder-led signups (WhatsApp, calls).
--                                    The table keeps its existing
--                                    Platform-Owner-only policies.
--   * marketing_spend_entries        the monthly cash spend ledger (EGP).
--   * growth_settings                the season / capacity singleton, seeded.
--
-- Additive only: a new enum, nullable columns, two new tables and the
-- settings seed row; nothing existing changes.

-- CreateEnum
CREATE TYPE "acquisition_channel" AS ENUM (
  'facebook', 'instagram', 'youtube', 'tiktok', 'whatsapp', 'teacher_referral',
  'assistant_or_agency', 'google_search', 'google_ads', 'meta_ads', 'ai_assistant',
  'event', 'email', 'partner', 'other', 'unknown'
);

-- AlterTable
ALTER TABLE "organizations"
  ADD COLUMN "heard_from" "acquisition_channel",
  ADD COLUMN "heard_from_other" VARCHAR(100);

-- AlterTable
ALTER TABLE "platform_contact_submissions"
  ADD COLUMN "heard_from" "acquisition_channel",
  ADD COLUMN "heard_from_other" VARCHAR(100);

-- AlterTable
ALTER TABLE "organization_platform_flags"
  ADD COLUMN "acquisition_channel_override" "acquisition_channel",
  ADD COLUMN "acquisition_override_note" VARCHAR(200);

-- CreateTable
CREATE TABLE "marketing_spend_entries" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "channel" "acquisition_channel" NOT NULL,
    "amount_minor_units" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'EGP',
    "description" VARCHAR(200),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" TEXT NOT NULL,
    "updated_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_spend_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "growth_settings" (
    "id" SMALLINT NOT NULL,
    "season_start" DATE NOT NULL DEFAULT '2027-06-01',
    "season_end" DATE NOT NULL DEFAULT '2027-09-30',
    "weekly_owner_hours" DECIMAL(5,1) NOT NULL DEFAULT 15,
    "onboarding_cap_per_week" INTEGER NOT NULL DEFAULT 5,
    "minutes_per_onboarding" INTEGER NOT NULL DEFAULT 120,
    "support_minutes_per_paying_org_per_week" INTEGER NOT NULL DEFAULT 10,
    "hire_warn_paying_orgs" INTEGER NOT NULL DEFAULT 33,
    "hire_now_paying_orgs" INTEGER NOT NULL DEFAULT 40,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_user_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "growth_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "marketing_spend_entries_month_channel_idx" ON "marketing_spend_entries"("month", "channel");

-- ---------------------------------------------------------------------------
-- Integrity (cheap CHECKs; the API validates the same rules first)
-- ---------------------------------------------------------------------------

-- The self-reported answer is one of the options the forms offer; the free
-- text belongs to `other` only.
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_heard_from_check"
    CHECK ("heard_from" IS NULL OR "heard_from" IN (
      'facebook', 'youtube', 'tiktok', 'instagram', 'whatsapp', 'teacher_referral',
      'assistant_or_agency', 'google_search', 'ai_assistant', 'event', 'other')),
  ADD CONSTRAINT "organizations_heard_from_other_check"
    CHECK ("heard_from_other" IS NULL
        OR ("heard_from" = 'other' AND char_length(btrim("heard_from_other")) BETWEEN 1 AND 100));

ALTER TABLE "platform_contact_submissions"
  ADD CONSTRAINT "platform_contact_submissions_heard_from_check"
    CHECK ("heard_from" IS NULL OR "heard_from" IN (
      'facebook', 'youtube', 'tiktok', 'instagram', 'whatsapp', 'teacher_referral',
      'assistant_or_agency', 'google_search', 'ai_assistant', 'event', 'other')),
  ADD CONSTRAINT "platform_contact_submissions_heard_from_other_check"
    CHECK ("heard_from_other" IS NULL
        OR ("heard_from" = 'other' AND char_length(btrim("heard_from_other")) BETWEEN 1 AND 100));

ALTER TABLE "organization_platform_flags"
  ADD CONSTRAINT "organization_platform_flags_acquisition_note_check"
    CHECK ("acquisition_override_note" IS NULL OR "acquisition_channel_override" IS NOT NULL);

ALTER TABLE "marketing_spend_entries"
  ADD CONSTRAINT "marketing_spend_entries_month_check" CHECK (EXTRACT(DAY FROM "month") = 1),
  ADD CONSTRAINT "marketing_spend_entries_channel_check" CHECK ("channel" <> 'unknown'),
  ADD CONSTRAINT "marketing_spend_entries_amount_check"
    CHECK ("amount_minor_units" > 0 AND "amount_minor_units" <= 10000000000),
  ADD CONSTRAINT "marketing_spend_entries_currency_check" CHECK ("currency" = 'EGP'),
  ADD CONSTRAINT "marketing_spend_entries_description_check"
    CHECK ("description" IS NULL OR char_length(btrim("description")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "marketing_spend_entries_version_check" CHECK ("version" >= 1);

ALTER TABLE "growth_settings"
  ADD CONSTRAINT "growth_settings_singleton_check" CHECK ("id" = 1),
  ADD CONSTRAINT "growth_settings_season_check" CHECK ("season_end" > "season_start"),
  ADD CONSTRAINT "growth_settings_owner_hours_check" CHECK ("weekly_owner_hours" BETWEEN 1 AND 80),
  ADD CONSTRAINT "growth_settings_onboarding_cap_check" CHECK ("onboarding_cap_per_week" BETWEEN 1 AND 50),
  ADD CONSTRAINT "growth_settings_minutes_per_onboarding_check" CHECK ("minutes_per_onboarding" BETWEEN 15 AND 600),
  ADD CONSTRAINT "growth_settings_support_minutes_check"
    CHECK ("support_minutes_per_paying_org_per_week" BETWEEN 0 AND 240),
  ADD CONSTRAINT "growth_settings_hire_thresholds_check"
    CHECK ("hire_warn_paying_orgs" BETWEEN 1 AND 10000
       AND "hire_now_paying_orgs" BETWEEN 1 AND 10000
       AND "hire_now_paying_orgs" >= "hire_warn_paying_orgs"),
  ADD CONSTRAINT "growth_settings_version_check" CHECK ("version" >= 1);

-- ---------------------------------------------------------------------------
-- Row-level security — Platform Owners only, reads included, exactly like
-- `launch_checklist_items`. Who may call is decided by `PlatformOwnerGuard`;
-- this is the second line. `growth_settings` is a seeded singleton: no
-- INSERT or DELETE policy, so nobody (not even a Platform Owner through the
-- application role) can add or remove the row.
-- ---------------------------------------------------------------------------

ALTER TABLE "marketing_spend_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketing_spend_entries" FORCE ROW LEVEL SECURITY;

CREATE POLICY "marketing_spend_entries_platform_select" ON "marketing_spend_entries"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "marketing_spend_entries_platform_insert" ON "marketing_spend_entries"
  FOR INSERT
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "marketing_spend_entries_platform_update" ON "marketing_spend_entries"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "marketing_spend_entries_platform_delete" ON "marketing_spend_entries"
  FOR DELETE
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

ALTER TABLE "growth_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growth_settings" FORCE ROW LEVEL SECURITY;

CREATE POLICY "growth_settings_platform_select" ON "growth_settings"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "growth_settings_platform_update" ON "growth_settings"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

-- ---------------------------------------------------------------------------
-- Settings defaults (owner decision, 26 Oct 2026): season 1 Jun – 30 Sep
-- 2027, 15 owner hours a week, 5 onboardings a week, warn at 33 paying
-- organizations, hire at 40.
-- ---------------------------------------------------------------------------

INSERT INTO "growth_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
