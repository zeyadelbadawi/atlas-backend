-- P64 Phase 4 §E.5 — the Platform Owner's video-minutes / provider-health
-- view (`GET /platform-metrics/video`) aggregates `media_assets` under the
-- platform owner's RLS context. Until now `media_assets` had only tenant /
-- lesson-access / uploader / submission-review SELECT policies, so that read
-- saw zero rows. This adds the same read-only `_platform_select` policy P15
-- gave `organizations`/`academies`/`courses` — SELECT only, gated by
-- `is_platform_owner()`, no write widening, no change to any other policy.
-- Additive and idempotent.
DROP POLICY IF EXISTS "media_assets_platform_select" ON "media_assets";
CREATE POLICY "media_assets_platform_select" ON "media_assets"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));
