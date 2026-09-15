-- P54 — Arabic plan names/descriptions, stored WHERE PLAN TEXT IS
-- AUTHORITATIVE: the `plans` catalog row.
--
-- ROOT CAUSE THIS FIXES. `plans.name`/`plans.description` are single-locale
-- English strings seeded into the catalog, and `GET /plans` returns them
-- verbatim, so the Plans page renders "Growth" / "For growing organizations
-- running multiple academies." in Arabic too. That is a DATA gap, not a UI
-- translation gap — which is why the fix is here and not a hardcoded string
-- table in the frontend. Plans are catalog rows Atlas can add to; a plan
-- added tomorrow must be translatable without a frontend release.
--
-- SHAPE: the `{ en, ar }` `LocalizedText` object this codebase already uses
-- for every other piece of bilingual business content (website CMS entries,
-- inline section content, SEO fields — `LocalizedTextResponse` in
-- `website-faq-entry.contract.ts`, resolved on the frontend by the existing
-- `resolveLocalizedText`). No second localization mechanism is introduced;
-- the existing one is applied to a table that had not adopted it yet.
--
-- ADDITIVE, NOT A REPLACEMENT. `name`/`description` stay exactly as they
-- are and stay authoritative for English and for every non-UI reader
-- (audit log labels, admin subscription views, checkout). The new columns
-- are nullable: a plan without them simply falls back to `name`, which is
-- precisely what `resolveLocalizedText(value: LocalizedText | string)`
-- already does for a plain string. Nothing breaks if a future plan is
-- inserted without translations.

ALTER TABLE "plans"
  ADD COLUMN IF NOT EXISTS "name_localized" JSONB,
  ADD COLUMN IF NOT EXISTS "description_localized" JSONB;

-- BACKFILL FOR THE PLANS THAT ACTUALLY EXIST, by key, from the seeded
-- English text (`prisma/seed.ts`). Keyed lookups, not positional: a
-- database that has only some of these plans gets exactly those updated,
-- and a plan key that is absent is simply not matched. Re-runnable.
--
-- The English side is carried across verbatim rather than re-typed, so the
-- two locales cannot drift from the row they describe.
UPDATE "plans"
SET
  "name_localized" = jsonb_build_object('en', "name", 'ar', 'الأساسية'),
  "description_localized" = jsonb_build_object(
    'en', COALESCE("description", ''),
    'ar', 'لأكاديمية واحدة في بداية الطريق.'
  )
WHERE "key" = 'starter';

UPDATE "plans"
SET
  "name_localized" = jsonb_build_object('en', "name", 'ar', 'النمو'),
  "description_localized" = jsonb_build_object(
    'en', COALESCE("description", ''),
    'ar', 'للمؤسسات المتنامية التي تدير عدة أكاديميات.'
  )
WHERE "key" = 'growth';

UPDATE "plans"
SET
  "name_localized" = jsonb_build_object('en', "name", 'ar', 'المؤسسات'),
  "description_localized" = jsonb_build_object(
    'en', COALESCE("description", ''),
    'ar', 'نطاق غير محدود للمؤسسات الكبيرة.'
  )
WHERE "key" = 'enterprise';
