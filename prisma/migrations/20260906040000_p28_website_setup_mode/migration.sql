-- ============================================================================
-- P28 — Bilingual Academy Websites (Phase 6).
--
-- One new, nullable, purely additive column: `provisioning_requests`
-- already has `selected_theme_key` (P19) recording the Client's chosen
-- theme; this adds its sibling, recording whether the generated website
-- should start "empty" (a real, structured, theme-appropriate shell) or
-- "complete" (the same shell, additionally filled with real bilingual
-- starter content). NULL is the correct, safe value for every
-- `provisioning_requests` row that existed before this migration, and is
-- treated identically to `'empty'` by `executeThemeStep` — see that
-- method's own doc comment. No backfill needed or performed.
-- ============================================================================

ALTER TABLE "provisioning_requests"
  ADD COLUMN "website_setup_mode" TEXT;
