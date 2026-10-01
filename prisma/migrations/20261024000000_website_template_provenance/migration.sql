-- Theme 1 plan §D.2 (Phase 2) — starter-content provenance.
--
-- WHAT IT RECORDS. Which website template, at which template version, first
-- generated an Academy's starter pages. `theme_key` can't answer that: it
-- changes on every theme switch, and a later template version (Theme 1's v2
-- ships in Phase 7) reuses the same key. Without these columns there is no
-- way to tell, afterwards, which Academies hold v1 starter content — which
-- the plan's legacy verification (§D.5) and a future, explicit "Refresh
-- Starter Content" (out of scope) both need.
--
-- ADDITIVE AND NULLABLE. Existing rows get NULL, meaning "unknown / not
-- recorded" — nothing is backfilled or guessed, and no Academy data is
-- rewritten. `WebsiteGenerationService` stamps them once, when it first
-- generates a website; it never overwrites a value.
--
-- No RLS change: `website_configurations`' existing policies already cover
-- these columns, and the app role's table-level grants include new columns.
-- Rollback: older code ignores both columns; dropping them is optional.
ALTER TABLE "website_configurations"
  ADD COLUMN "template_key" TEXT,
  ADD COLUMN "template_version" INTEGER;
