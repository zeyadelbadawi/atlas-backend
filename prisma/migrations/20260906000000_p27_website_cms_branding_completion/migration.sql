-- ============================================================================
-- P27 — Phase 6 (Website, CMS & Branding Completion).
--
-- 1. `blog_posts`: adds `scheduled` to `blog_post_status`, plus
--    `scheduled_at`/`meta_title`/`meta_description`/`og_image_url` —
--    mirrors `announcements`' own pre-existing `scheduled`/`scheduled_at`
--    shape exactly, so the SAME Phase 2 scheduler tick
--    (`SubscriptionSweepService`) can publish both without a second
--    scheduling mechanism.
--
-- 2. `announcements`: only the course-scoped authoring path had RLS
--    INSERT/UPDATE/manage-SELECT policies (`announcements_manage_*`,
--    P7 migration — all three require `course_id IS NOT NULL`). The
--    `platform`/`academy` audiences already had real read policies
--    (`announcements_platform_select`/`_academy_member_select`) but no
--    write path at all — this migration adds the missing
--    academy-moderator and platform-owner authoring policies, additive
--    to (never replacing) the existing course-scoped ones. Also adds a
--    platform-wide bypass so the Phase 2 scheduler tick (running as the
--    platform owner, exactly like its existing stale-usage scan) can find
--    and publish EVERY due `scheduled` announcement regardless of which
--    academy/course it belongs to — mirrors `organizations_platform_select`
--    (P15)'s own precedent for "the platform owner's session sees
--    everything" exactly.
--
-- 3. `blog_posts`: the identical platform-wide scheduler bypass, for the
--    same reason.
--
-- 4. `contact_submissions` (new table): the real backend destination for
--    the public Contact section's form, previously an intentional no-op
--    ("no fake backend"). Insert is public (no session at all — the
--    public website controller carries no guard, matching every other
--    public-website write... except there are none yet; this is the
--    first), so the `WITH CHECK` cannot depend on `app.current_user_id`.
--    It instead depends on `app.current_organization_id`, which the
--    calling service sets via `runInTenantContext` using the
--    SERVER-resolved organization for the target academy (never a
--    client-supplied organization id) — the same "trusted hostname/id
--    resolution chain, never a client-supplied parameter trusted on its
--    own" invariant `PublicWebsiteService`'s own doc comment already
--    documents for reads, now extended to this one write.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- blog_posts: scheduling + SEO metadata
-- ---------------------------------------------------------------------------

ALTER TYPE "blog_post_status" ADD VALUE 'scheduled';

ALTER TABLE "blog_posts"
  ADD COLUMN "scheduled_at" TIMESTAMP(3),
  ADD COLUMN "meta_title" TEXT,
  ADD COLUMN "meta_description" TEXT,
  ADD COLUMN "og_image_url" TEXT;

-- ---------------------------------------------------------------------------
-- is_academy_moderator — matches `is_course_moderator`'s own shape
-- (STABLE, SECURITY DEFINER, SET search_path) — the one role check every
-- academy-scoped "owner/administrator/manager may author" service in this
-- codebase already performs at the application layer
-- (`AnnouncementsService`'s own `MANAGING_ROLES` constant), now also
-- expressed at the RLS layer for the two new write paths this phase adds.
-- ---------------------------------------------------------------------------

CREATE FUNCTION is_academy_moderator(p_academy_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "academy_members"
    WHERE "academy_id" = p_academy_id
      AND "user_id" = p_user_id
      AND "role" IN ('owner', 'administrator', 'manager')
  );
$$;

-- ---------------------------------------------------------------------------
-- announcements: academy-wide authoring (additive to the existing
-- course-scoped `announcements_manage_*` policies — never replacing them)
-- ---------------------------------------------------------------------------

CREATE POLICY "announcements_academy_manage_select" ON "announcements"
  FOR SELECT
  USING (
    "announcements"."academy_id" IS NOT NULL
    AND "announcements"."course_id" IS NULL
    AND is_academy_moderator("announcements"."academy_id", current_setting('app.current_user_id', true))
  );

CREATE POLICY "announcements_academy_manage_insert" ON "announcements"
  FOR INSERT
  WITH CHECK (
    "announcements"."audience" = 'academy'
    AND "announcements"."academy_id" IS NOT NULL
    AND "announcements"."course_id" IS NULL
    AND is_academy_moderator("announcements"."academy_id", current_setting('app.current_user_id', true))
  );

CREATE POLICY "announcements_academy_manage_update" ON "announcements"
  FOR UPDATE
  USING (
    "announcements"."academy_id" IS NOT NULL
    AND "announcements"."course_id" IS NULL
    AND is_academy_moderator("announcements"."academy_id", current_setting('app.current_user_id', true))
  )
  WITH CHECK (
    "announcements"."academy_id" IS NOT NULL
    AND "announcements"."course_id" IS NULL
    AND is_academy_moderator("announcements"."academy_id", current_setting('app.current_user_id', true))
  );

-- ---------------------------------------------------------------------------
-- announcements: platform-wide authoring — Platform Owner only
-- ---------------------------------------------------------------------------

CREATE POLICY "announcements_platform_manage_select" ON "announcements"
  FOR SELECT
  USING (
    "announcements"."audience" = 'platform'
    AND is_platform_owner(current_setting('app.current_user_id', true))
  );

CREATE POLICY "announcements_platform_manage_insert" ON "announcements"
  FOR INSERT
  WITH CHECK (
    "announcements"."audience" = 'platform'
    AND "announcements"."academy_id" IS NULL
    AND "announcements"."course_id" IS NULL
    AND is_platform_owner(current_setting('app.current_user_id', true))
  );

CREATE POLICY "announcements_platform_manage_update" ON "announcements"
  FOR UPDATE
  USING (
    "announcements"."audience" = 'platform'
    AND is_platform_owner(current_setting('app.current_user_id', true))
  )
  WITH CHECK (
    "announcements"."audience" = 'platform'
    AND is_platform_owner(current_setting('app.current_user_id', true))
  );

-- ---------------------------------------------------------------------------
-- announcements + blog_posts: platform-wide scheduler bypass — the Phase 2
-- sweep tick runs as the platform owner (exactly like its existing
-- stale-usage scan, `SubscriptionExpiryService`'s trial scan) and must be
-- able to find and publish EVERY due scheduled row regardless of academy/
-- course, mirroring `organizations_platform_select`'s (P15) own precedent.
-- ---------------------------------------------------------------------------

CREATE POLICY "announcements_platform_schedule_select" ON "announcements"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "announcements_platform_schedule_update" ON "announcements"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "blog_posts_platform_schedule_select" ON "blog_posts"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "blog_posts_platform_schedule_update" ON "blog_posts"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

-- ---------------------------------------------------------------------------
-- contact_submissions (new table)
-- ---------------------------------------------------------------------------

CREATE TYPE "contact_submission_status" AS ENUM ('new', 'read', 'archived');

CREATE TABLE "contact_submissions" (
    "id"         TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "email"      TEXT NOT NULL,
    "message"    TEXT NOT NULL,
    "status"     "contact_submission_status" NOT NULL DEFAULT 'new',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_submissions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "contact_submissions_academy_id_status_idx"
  ON "contact_submissions" ("academy_id", "status");

ALTER TABLE "contact_submissions"
  ADD CONSTRAINT "contact_submissions_academy_id_fkey"
  FOREIGN KEY ("academy_id") REFERENCES "academies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "contact_submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_submissions" FORCE ROW LEVEL SECURITY;

-- Public insert: no session/guard exists on this write path at all (the
-- public website controller is deliberately unauthenticated). The
-- server-resolved organization id (never a client-supplied one) is set
-- via `runInTenantContext` before this insert runs, so this check still
-- keeps a submission honestly tied to a real academy of that same
-- organization — never an arbitrary academy id smuggled in the request
-- body.
CREATE POLICY "contact_submissions_public_insert" ON "contact_submissions"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "contact_submissions"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

-- Academy staff (owner/administrator/manager) can read and triage their
-- own academy's submissions — never another academy's.
CREATE POLICY "contact_submissions_manage_select" ON "contact_submissions"
  FOR SELECT
  USING (is_academy_moderator("contact_submissions"."academy_id", current_setting('app.current_user_id', true)));

CREATE POLICY "contact_submissions_manage_update" ON "contact_submissions"
  FOR UPDATE
  USING (is_academy_moderator("contact_submissions"."academy_id", current_setting('app.current_user_id', true)))
  WITH CHECK (is_academy_moderator("contact_submissions"."academy_id", current_setting('app.current_user_id', true)));
