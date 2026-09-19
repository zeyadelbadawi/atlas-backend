-- ============================================================================
-- P64 Phase 2 — CORRECTION: a learner could not read the media assets their
-- own lesson points at (security audit finding SEC-1).
--
-- WHAT WAS WRONG
--
-- `media_assets` has exactly one SELECT policy, `media_assets_tenant_select`
-- (P8), and it is keyed on `app.current_organization_id`. That is correct
-- for the Media Library, whose only readers are staff holding an
-- organization context.
--
-- The P64 Phase 2 grant path is not that. `LessonContentService.getContent`
-- runs the entire entitlement decision in `runInUserContext`, which sets
-- `app.current_user_id` and deliberately NO organization — a learner has no
-- organization membership, which is the whole point of the derived
-- principal model (AD-4). So every `media_assets` read from that path
-- matched zero rows.
--
-- IT FAILED SILENTLY, WHICH IS WHY NOTHING CAUGHT IT. RLS does not raise on
-- a filtered row; it returns nothing. `lesson.videoAsset` was simply always
-- `null`, so:
--
--   * no video was ever signed, for either tier;
--   * the grant still reported `signedUrl: true` — overstating the
--     protection actually in force, which is precisely what AD-16 forbids;
--   * `processingStatus !== 'ready'` could never fire;
--   * the signer's cross-academy refusal was unreachable from the learner
--     path, so the one place Atlas guarantees it never mints a
--     cross-tenant capability was never exercised;
--   * file lessons returned no `fileUrl` and protected resources were
--     dropped without a word;
--   * `content_access_log.security_tier`/`provider` were always null.
--
-- Every one of those is a Phase 2 acceptance criterion.
--
-- THE FIX
--
-- One ADDITIVE policy, admitting exactly the assets a lesson the caller may
-- already access points at. Nothing existing is dropped or widened: staff
-- keep reading the Media Library through the organization tier, and this
-- tier grants a learner nothing beyond the specific objects their own
-- entitled lesson references.
--
-- SECURITY DEFINER, for the reason Phase 1 established over two corrective
-- migrations (20261008000400, 20261008000700): an inline EXISTS in a policy
-- runs as the INVOKING role and therefore evaluates every policy of every
-- table it reaches into, once per candidate row. This question needs
-- `course_lessons`, `lesson_contents` and `lesson_resources`; asked inline
-- it would be both wrong (those tables have their own policies, which would
-- filter the join) and slow.
--
-- The function grants no visibility of its own: it answers a boolean about
-- the caller, keyed on the caller id the POLICY passes in from
-- `app.current_user_id`, never on anything a caller can send.
-- ============================================================================

CREATE OR REPLACE FUNCTION can_access_media_asset(p_asset_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- The lesson's VIDEO.
  SELECT EXISTS (
    SELECT 1
    FROM "course_lessons" l
    WHERE l."video_asset_id" = p_asset_id
      AND can_access_lesson(l."id", p_user_id)
  )
  -- The lesson's BODY or file payload.
  OR EXISTS (
    SELECT 1
    FROM "lesson_contents" lc
    WHERE lc."media_asset_id" = p_asset_id
      AND can_access_lesson(lc."lesson_id", p_user_id)
  )
  -- A downloadable RESOURCE attached to the lesson.
  OR EXISTS (
    SELECT 1
    FROM "lesson_resources" lr
    WHERE lr."media_asset_id" = p_asset_id
      AND can_access_lesson(lr."lesson_id", p_user_id)
  );
$$;

DROP POLICY IF EXISTS "media_assets_lesson_access_select" ON "media_assets";
CREATE POLICY "media_assets_lesson_access_select" ON "media_assets"
  FOR SELECT
  USING (
    current_setting('app.current_user_id', true) IS NOT NULL
    AND current_setting('app.current_user_id', true) <> ''
    AND can_access_media_asset("media_assets"."id", current_setting('app.current_user_id', true))
  );

-- The three lookups the function performs are all equality matches on a
-- single column, and none of them was indexed — `video_asset_id` had an
-- index already, the other two are added here so this policy is an indexed
-- lookup rather than a scan of every lesson payload on the platform.
CREATE INDEX IF NOT EXISTS "lesson_contents_media_asset_id_lookup_idx"
  ON "lesson_contents"("media_asset_id")
  WHERE "media_asset_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "lesson_resources_media_asset_id_lookup_idx"
  ON "lesson_resources"("media_asset_id")
  WHERE "media_asset_id" IS NOT NULL;


-- ---------------------------------------------------------------------------
-- CORRECTION 2: no content-access refusal was ever recorded (finding SEC-2)
--
-- `content_access_log_insert`'s WITH CHECK is
--   user_id IS NULL OR user_id = current_setting('app.current_user_id', true)
--
-- `logRefusal` deliberately writes OUTSIDE any context — a learner who was
-- just refused may have no rows visible to them at all, and the record of
-- the refusal has to exist regardless. But out of context
-- `current_setting(...)` is NULL, so for an authenticated refusal the
-- comparison is `user_id = NULL`, which is NULL, which is not TRUE — and
-- the insert was rejected with 42501. Every authenticated refusal was lost.
--
-- Anonymous refusals passed the check and then failed anyway, because
-- Prisma's `INSERT … RETURNING` needs a SELECT tier and no policy gave one
-- to an uncontextualised caller.
--
-- Both failures were swallowed by `ContentAccessLogRepository.record`,
-- which is right — an audit write must never fail the request it audits —
-- and is exactly why this went unnoticed.
--
-- THE FIX. The INSERT policy admits a row whose `user_id` is either absent,
-- or matches the current user when there IS one. Writing an audit record
-- about a refusal is not a privileged act: the row names only facts the
-- server already decided, and refusing to store it protects nobody. A
-- narrow SELECT tier is added for the same statement's RETURNING clause,
-- scoped to rows the caller just wrote.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "content_access_log_insert" ON "content_access_log";
CREATE POLICY "content_access_log_insert" ON "content_access_log"
  FOR INSERT
  WITH CHECK (
    "content_access_log"."user_id" IS NULL
    OR current_setting('app.current_user_id', true) IS NULL
    OR current_setting('app.current_user_id', true) = ''
    OR "content_access_log"."user_id" = current_setting('app.current_user_id', true)
  );
