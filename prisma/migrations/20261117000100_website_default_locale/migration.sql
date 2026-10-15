-- B0-WEB-02 — Arabic as an academy website's default language.
--
-- WHAT IT RECORDS. Which language a website serves at its root: `en`
-- (English at `/`, Arabic under `/ar` — every site's behaviour until now)
-- or `ar` (Arabic at `/`, English under `/en`).
--
-- ADDITIVE, WITH A DEFAULT. Every existing row gets `en`, so every existing
-- site keeps exactly the URLs, sitemap and head tags it serves today. The
-- column is the working copy; what visitors see is copied into
-- `published_snapshot` at publish (a snapshot without it means `en`).
--
-- No RLS change: `website_configurations`' existing policies already cover
-- the column, and the app role's table-level grants include new columns.
-- Rollback: older code ignores the column; dropping it is optional.
ALTER TABLE "website_configurations"
  ADD COLUMN "default_locale" TEXT NOT NULL DEFAULT 'en';

ALTER TABLE "website_configurations"
  ADD CONSTRAINT "website_configurations_default_locale_check" CHECK ("default_locale" IN ('en', 'ar'));
