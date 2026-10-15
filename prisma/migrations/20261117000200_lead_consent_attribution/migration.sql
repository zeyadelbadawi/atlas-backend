-- =============================================================================
-- B0-SUP-04 / B0-IAM-08 / B0-ANL-04 (part 2) — consent records and signup /
-- enquiry attribution. ADDITIVE ONLY: new nullable columns, CHECK
-- constraints on those columns, one trigger, one SECURITY DEFINER reader.
--
-- Nothing here changes behaviour on its own. The application writes these
-- columns only while the matching flag is on (all default OFF:
-- FLAG_CONTACT_CONSENT_MODE, FLAG_SIGNUP_WHATSAPP_CONSENT_MODE,
-- FLAG_ATTRIBUTION_CAPTURE_MODE), because the consent wording is still a
-- DRAFT pending counsel. Every consent is stored as "when" + "which wording
-- version" (e.g. `contact-consent-2026-10-draft1`), so an approved wording
-- becomes a new version and older consents stay attributable to the text
-- the person actually saw. A NULL timestamp means "not given".
--
-- 1. `platform_contact_submissions` (platform-level, NOT tenant data): an
--    optional WhatsApp number, two separate consents (being contacted about
--    this enquiry; marketing), optional sales qualification fields and the
--    attribution object. The existing RLS is unchanged: the anonymous INSERT
--    policy still only admits fresh `new` rows, and SELECT/UPDATE/DELETE
--    stay Platform-Owner-only.
-- 2. `organizations.signup_attribution` — UTM values, referrer DOMAIN and
--    landing template captured at organization signup. Existing
--    organization policies apply (the organization's own members and the
--    Platform Owner read it); it holds no personal data — the application
--    drops anything that looks like an email address or a phone number.
-- 3. `user_phones.whatsapp_consent_*` — the organization owner's opt-in to
--    WhatsApp contact about their account and setup. Self-only FORCE RLS is
--    unchanged. Like `verified_at`, the consent is for ONE number: the
--    database clears it whenever the number changes.
-- 4. `platform_organization_owner_phones(org_ids)` — the Platform Owner's
--    ONLY reader of an organization owner's number, and it returns a number
--    only when that owner opted in. Learner numbers are not reachable here.
--
-- Rollback (data is lost for the new columns only):
--   DROP FUNCTION platform_organization_owner_phones(text[]);
--   DROP TRIGGER "user_phones_clear_whatsapp_consent_on_change" ON "user_phones";
--   DROP FUNCTION user_phones_clear_whatsapp_consent_on_change();
--   ALTER TABLE "user_phones" DROP COLUMN "whatsapp_consent_at", DROP COLUMN "whatsapp_consent_version";
--   ALTER TABLE "organizations" DROP COLUMN "signup_attribution";
--   ALTER TABLE "platform_contact_submissions" DROP COLUMN ... (the columns below).
-- =============================================================================

-- 1. Marketing contact enquiries ---------------------------------------------

ALTER TABLE "platform_contact_submissions"
  ADD COLUMN IF NOT EXISTS "phone_e164" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "phone_country" VARCHAR(2),
  ADD COLUMN IF NOT EXISTS "contact_consent_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "contact_consent_version" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "marketing_consent_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "marketing_consent_version" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "requester_role" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "subject" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "student_band" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "preferred_channel" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "attribution" JSONB;

DO $$ BEGIN
  ALTER TABLE "platform_contact_submissions"
    ADD CONSTRAINT "platform_contact_submissions_phone_pair_check"
    CHECK (("phone_e164" IS NULL) = ("phone_country" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "platform_contact_submissions"
    ADD CONSTRAINT "platform_contact_submissions_contact_consent_check"
    CHECK (("contact_consent_at" IS NULL) = ("contact_consent_version" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "platform_contact_submissions"
    ADD CONSTRAINT "platform_contact_submissions_marketing_consent_check"
    CHECK (("marketing_consent_at" IS NULL) = ("marketing_consent_version" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "platform_contact_submissions"
    ADD CONSTRAINT "platform_contact_submissions_requester_role_check"
    CHECK ("requester_role" IS NULL
      OR "requester_role" IN ('academy_owner', 'teacher', 'centre_manager', 'other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "platform_contact_submissions"
    ADD CONSTRAINT "platform_contact_submissions_student_band_check"
    CHECK ("student_band" IS NULL
      OR "student_band" IN ('under_50', '50_200', '200_1000', 'over_1000'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "platform_contact_submissions"
    ADD CONSTRAINT "platform_contact_submissions_preferred_channel_check"
    CHECK ("preferred_channel" IS NULL
      OR "preferred_channel" IN ('whatsapp', 'email', 'phone_call'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "platform_contact_submissions"
    ADD CONSTRAINT "platform_contact_submissions_attribution_size_check"
    CHECK ("attribution" IS NULL
      OR (jsonb_typeof("attribution") = 'object' AND octet_length("attribution"::text) <= 2048));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Marketing eligibility is read as "marketing consent given"; a partial
-- index keeps that list cheap without touching the other queries.
CREATE INDEX IF NOT EXISTS "platform_contact_submissions_marketing_consent_idx"
  ON "platform_contact_submissions"("marketing_consent_at")
  WHERE "marketing_consent_at" IS NOT NULL;

-- 2. Organization signup attribution -----------------------------------------

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "signup_attribution" JSONB;

DO $$ BEGIN
  ALTER TABLE "organizations"
    ADD CONSTRAINT "organizations_signup_attribution_size_check"
    CHECK ("signup_attribution" IS NULL
      OR (jsonb_typeof("signup_attribution") = 'object'
          AND octet_length("signup_attribution"::text) <= 2048));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. Organization owner WhatsApp opt-in --------------------------------------

ALTER TABLE "user_phones"
  ADD COLUMN IF NOT EXISTS "whatsapp_consent_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "whatsapp_consent_version" VARCHAR(64);

DO $$ BEGIN
  ALTER TABLE "user_phones"
    ADD CONSTRAINT "user_phones_whatsapp_consent_check"
    CHECK (("whatsapp_consent_at" IS NULL) = ("whatsapp_consent_version" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The opt-in was given for ONE number. Whatever path changes the number,
-- the consent does not carry over — same rule as `verified_at`.
CREATE OR REPLACE FUNCTION user_phones_clear_whatsapp_consent_on_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW."phone_e164" IS DISTINCT FROM OLD."phone_e164" THEN
    NEW."whatsapp_consent_at" := NULL;
    NEW."whatsapp_consent_version" := NULL;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION user_phones_clear_whatsapp_consent_on_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS "user_phones_clear_whatsapp_consent_on_change" ON "user_phones";
CREATE TRIGGER "user_phones_clear_whatsapp_consent_on_change"
  BEFORE UPDATE OF "phone_e164" ON "user_phones"
  FOR EACH ROW EXECUTE FUNCTION user_phones_clear_whatsapp_consent_on_change();

-- 4. The Platform Owner's reader of OPTED-IN organization owner numbers -----
--
-- Decides from `app.current_user_id` (never a parameter): a non-Platform-
-- Owner caller gets no row. Only the organization's CURRENT owner, and only
-- while that owner's opt-in stands; a learner's number is never returned.

CREATE OR REPLACE FUNCTION platform_organization_owner_phones(p_organization_ids text[])
RETURNS TABLE (
  organization_id text,
  user_id text,
  phone_e164 text,
  country_code text,
  whatsapp_consent_at timestamp(3),
  whatsapp_consent_version text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o."id", p."user_id", p."phone_e164"::text, p."country_code"::text,
         p."whatsapp_consent_at", p."whatsapp_consent_version"::text
  FROM "organizations" o
  JOIN "user_phones" p ON p."user_id" = o."owner_user_id"
  WHERE o."id" = ANY (p_organization_ids)
    AND p."whatsapp_consent_at" IS NOT NULL
    AND is_platform_owner(NULLIF(current_setting('app.current_user_id', true), ''));
$$;

REVOKE ALL ON FUNCTION platform_organization_owner_phones(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_organization_owner_phones(text[]) TO "atlas_app";
