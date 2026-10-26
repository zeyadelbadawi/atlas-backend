-- B3 — launch tooling, managed from the Platform Owner dashboard:
--
--   * platform_blog_posts      the marketing blog (one slug, EN + AR column
--                              groups). Not `blog_posts`: that table is the
--                              academy Knowledge Blog.
--   * site_announcements       marketing banner / marketing pop-up /
--                              dashboard banner, with view/click/dismiss
--                              counters.
--   * launch_checklist_items   the launch checklist, seeded below.
--
-- Additive only: new enums, tables, one SECURITY DEFINER function and the
-- checklist seed rows; nothing existing changes.

-- CreateEnum
CREATE TYPE "platform_blog_post_kind" AS ENUM ('pillar', 'cluster', 'article');

-- CreateEnum
CREATE TYPE "platform_blog_topic" AS ENUM ('protection', 'payments', 'exams', 'website', 'season', 'teaching', 'news');

-- CreateEnum
CREATE TYPE "platform_blog_post_status" AS ENUM ('draft', 'scheduled', 'published', 'archived');

-- CreateEnum
CREATE TYPE "site_announcement_surface" AS ENUM ('marketing_banner', 'marketing_popup', 'dashboard_banner');

-- CreateEnum
CREATE TYPE "site_announcement_status" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "site_announcement_tone" AS ENUM ('info', 'promo', 'success', 'warning');

-- CreateEnum
CREATE TYPE "site_announcement_popup_frequency" AS ENUM ('once', 'session', 'always');

-- CreateEnum
CREATE TYPE "site_announcement_audience" AS ENUM ('all', 'organization_owners', 'academy_staff');

-- CreateEnum
CREATE TYPE "launch_checklist_section" AS ENUM ('product', 'content', 'marketing', 'communication', 'operations');

-- CreateTable
CREATE TABLE "platform_blog_posts" (
    "id" TEXT NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "kind" "platform_blog_post_kind" NOT NULL,
    "topic" "platform_blog_topic" NOT NULL,
    "status" "platform_blog_post_status" NOT NULL DEFAULT 'draft',
    "publish_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "cover_image_url" VARCHAR(2000),
    "cover_image_width" INTEGER,
    "cover_image_height" INTEGER,
    "author_name" VARCHAR(80) NOT NULL DEFAULT 'Atlas team',
    "related_post_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "title_en" VARCHAR(140),
    "excerpt_en" VARCHAR(300),
    "body_en" TEXT,
    "cover_alt_en" VARCHAR(200),
    "seo_title_en" VARCHAR(70),
    "seo_description_en" VARCHAR(170),
    "reading_minutes_en" INTEGER,
    "title_ar" VARCHAR(140),
    "excerpt_ar" VARCHAR(300),
    "body_ar" TEXT,
    "cover_alt_ar" VARCHAR(200),
    "seo_title_ar" VARCHAR(70),
    "seo_description_ar" VARCHAR(170),
    "reading_minutes_ar" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" TEXT NOT NULL,
    "updated_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_blog_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_announcements" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "surface" "site_announcement_surface" NOT NULL,
    "status" "site_announcement_status" NOT NULL DEFAULT 'draft',
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "tone" "site_announcement_tone" NOT NULL DEFAULT 'info',
    "title_en" VARCHAR(120),
    "body_en" VARCHAR(600),
    "cta_label_en" VARCHAR(40),
    "title_ar" VARCHAR(120),
    "body_ar" VARCHAR(600),
    "cta_label_ar" VARCHAR(40),
    "cta_url" VARCHAR(2000),
    "image_url" VARCHAR(2000),
    "pages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dismissible" BOOLEAN NOT NULL DEFAULT true,
    "popup_delay_seconds" INTEGER NOT NULL DEFAULT 0,
    "popup_frequency" "site_announcement_popup_frequency" NOT NULL DEFAULT 'once',
    "audience" "site_announcement_audience" NOT NULL DEFAULT 'all',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "views" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "dismissals" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" TEXT NOT NULL,
    "updated_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "launch_checklist_items" (
    "id" TEXT NOT NULL,
    "section" "launch_checklist_section" NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" VARCHAR(1000) NOT NULL DEFAULT '',
    "link_url" VARCHAR(2000),
    "done" BOOLEAN NOT NULL DEFAULT false,
    "done_at" TIMESTAMP(3),
    "done_by_user_id" TEXT,
    "notes" VARCHAR(2000) NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" TEXT,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "launch_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_blog_posts_slug_key" ON "platform_blog_posts"("slug");

-- CreateIndex
CREATE INDEX "platform_blog_posts_status_publish_at_idx" ON "platform_blog_posts"("status", "publish_at" DESC);

-- CreateIndex
CREATE INDEX "platform_blog_posts_topic_status_publish_at_idx" ON "platform_blog_posts"("topic", "status", "publish_at" DESC);

-- CreateIndex
CREATE INDEX "platform_blog_posts_updated_at_idx" ON "platform_blog_posts"("updated_at" DESC);

-- CreateIndex
CREATE INDEX "site_announcements_status_surface_priority_idx" ON "site_announcements"("status", "surface", "priority" DESC);

-- CreateIndex
CREATE INDEX "site_announcements_updated_at_idx" ON "site_announcements"("updated_at" DESC);

-- CreateIndex
CREATE INDEX "launch_checklist_items_position_idx" ON "launch_checklist_items"("position");


-- ---------------------------------------------------------------------------
-- Integrity (cheap CHECKs; the API validates the same rules first)
-- ---------------------------------------------------------------------------

ALTER TABLE "platform_blog_posts"
  ADD CONSTRAINT "platform_blog_posts_slug_check"
    CHECK (char_length("slug") BETWEEN 3 AND 80 AND "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD CONSTRAINT "platform_blog_posts_author_name_check"
    CHECK (char_length(btrim("author_name")) BETWEEN 1 AND 80),
  ADD CONSTRAINT "platform_blog_posts_body_length_check"
    CHECK (("body_en" IS NULL OR char_length("body_en") <= 60000)
       AND ("body_ar" IS NULL OR char_length("body_ar") <= 60000)),
  ADD CONSTRAINT "platform_blog_posts_cover_image_check"
    CHECK (("cover_image_url" IS NULL AND "cover_image_width" IS NULL AND "cover_image_height" IS NULL)
        OR ("cover_image_url" IS NOT NULL AND "cover_image_width" > 0 AND "cover_image_height" > 0)),
  ADD CONSTRAINT "platform_blog_posts_publish_at_check"
    CHECK ("status" NOT IN ('scheduled', 'published') OR "publish_at" IS NOT NULL),
  ADD CONSTRAINT "platform_blog_posts_related_check"
    CHECK (cardinality(COALESCE("related_post_ids", ARRAY[]::TEXT[])) <= 3),
  ADD CONSTRAINT "platform_blog_posts_reading_minutes_check"
    CHECK (("reading_minutes_en" IS NULL OR "reading_minutes_en" >= 1)
       AND ("reading_minutes_ar" IS NULL OR "reading_minutes_ar" >= 1)),
  ADD CONSTRAINT "platform_blog_posts_version_check" CHECK ("version" >= 1);

ALTER TABLE "site_announcements"
  ADD CONSTRAINT "site_announcements_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  ADD CONSTRAINT "site_announcements_window_check"
    CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at"),
  ADD CONSTRAINT "site_announcements_popup_delay_check" CHECK ("popup_delay_seconds" BETWEEN 0 AND 60),
  ADD CONSTRAINT "site_announcements_priority_check" CHECK ("priority" BETWEEN 0 AND 100),
  ADD CONSTRAINT "site_announcements_pages_check"
    CHECK (cardinality(COALESCE("pages", ARRAY[]::TEXT[])) <= 20),
  ADD CONSTRAINT "site_announcements_counters_check"
    CHECK ("views" >= 0 AND "clicks" >= 0 AND "dismissals" >= 0),
  ADD CONSTRAINT "site_announcements_version_check" CHECK ("version" >= 1);

ALTER TABLE "launch_checklist_items"
  ADD CONSTRAINT "launch_checklist_items_title_check" CHECK (char_length(btrim("title")) BETWEEN 1 AND 160),
  ADD CONSTRAINT "launch_checklist_items_position_check" CHECK ("position" >= 0),
  ADD CONSTRAINT "launch_checklist_items_done_check" CHECK ("done" OR "done_at" IS NULL),
  ADD CONSTRAINT "launch_checklist_items_version_check" CHECK ("version" >= 1);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- Writes (INSERT / UPDATE / DELETE) on all three tables: Platform Owners
-- only, through `is_platform_owner(text)`, exactly like
-- `founding_memberships`. Who may call is decided by `PlatformOwnerGuard`;
-- this is the second line.
--
-- SELECT:
--   * platform_blog_posts — Platform Owners see every row; anybody else
--     (the anonymous public endpoints read with NO context) sees only a
--     public post: `scheduled`/`published` with `publish_at` reached. A
--     draft, an archived post or a future scheduled post is invisible.
--   * site_announcements — Platform Owners see every row; anybody else sees
--     only a LIVE announcement (active, inside its window). A dashboard
--     banner additionally needs a signed-in user context, so the anonymous
--     marketing endpoint cannot read one.
--   * launch_checklist_items — Platform Owners only.
--
-- The public counters are never written through the table: anonymous
-- callers use `record_site_announcement_event`, which touches only the
-- three counters of a live row.

ALTER TABLE "platform_blog_posts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_blog_posts" FORCE ROW LEVEL SECURITY;

CREATE POLICY "platform_blog_posts_select" ON "platform_blog_posts"
  FOR SELECT
  USING (
    is_platform_owner(current_setting('app.current_user_id', true))
    OR (
      "status" IN ('scheduled', 'published')
      AND "publish_at" IS NOT NULL
      AND "publish_at" <= now()
    )
  );

CREATE POLICY "platform_blog_posts_platform_insert" ON "platform_blog_posts"
  FOR INSERT
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "platform_blog_posts_platform_update" ON "platform_blog_posts"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "platform_blog_posts_platform_delete" ON "platform_blog_posts"
  FOR DELETE
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

ALTER TABLE "site_announcements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_announcements" FORCE ROW LEVEL SECURITY;

CREATE POLICY "site_announcements_select" ON "site_announcements"
  FOR SELECT
  USING (
    is_platform_owner(current_setting('app.current_user_id', true))
    OR (
      "status" = 'active'
      AND ("starts_at" IS NULL OR "starts_at" <= now())
      AND ("ends_at" IS NULL OR "ends_at" > now())
      AND (
        "surface" <> 'dashboard_banner'
        OR COALESCE(current_setting('app.current_user_id', true), '') <> ''
      )
    )
  );

CREATE POLICY "site_announcements_platform_insert" ON "site_announcements"
  FOR INSERT
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "site_announcements_platform_update" ON "site_announcements"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "site_announcements_platform_delete" ON "site_announcements"
  FOR DELETE
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

ALTER TABLE "launch_checklist_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "launch_checklist_items" FORCE ROW LEVEL SECURITY;

CREATE POLICY "launch_checklist_items_platform_select" ON "launch_checklist_items"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "launch_checklist_items_platform_insert" ON "launch_checklist_items"
  FOR INSERT
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "launch_checklist_items_platform_update" ON "launch_checklist_items"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "launch_checklist_items_platform_delete" ON "launch_checklist_items"
  FOR DELETE
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

-- ---------------------------------------------------------------------------
-- The one anonymous write: a view / click / dismiss on a LIVE announcement
-- ---------------------------------------------------------------------------
--
-- Increments exactly one counter of a live row and nothing else (not
-- `updated_at`, not `version`, so a counter never makes an editor's copy
-- stale or re-shows a dismissed banner). Unknown ids, non-live rows and
-- unknown event types change nothing and return 0.

CREATE OR REPLACE FUNCTION record_site_announcement_event(p_id text, p_type text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF p_type NOT IN ('view', 'click', 'dismiss') THEN
    RETURN 0;
  END IF;
  UPDATE "site_announcements"
     SET "views" = "views" + CASE WHEN p_type = 'view' THEN 1 ELSE 0 END,
         "clicks" = "clicks" + CASE WHEN p_type = 'click' THEN 1 ELSE 0 END,
         "dismissals" = "dismissals" + CASE WHEN p_type = 'dismiss' THEN 1 ELSE 0 END
   WHERE "id" = p_id
     AND "status" = 'active'
     AND ("starts_at" IS NULL OR "starts_at" <= now())
     AND ("ends_at" IS NULL OR "ends_at" > now());
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_app') THEN
    REVOKE ALL ON FUNCTION record_site_announcement_event(text, text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION record_site_announcement_event(text, text) TO "atlas_app";
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Launch checklist defaults (owner decision, 26 Oct 2026). The restore
-- drill was run on 26 Oct 2026, so it starts done.
-- ---------------------------------------------------------------------------

INSERT INTO "launch_checklist_items"
  ("id", "section", "title", "description", "link_url", "done", "done_at", "position", "updated_at")
VALUES
  (gen_random_uuid()::text, 'product', 'Demo academy al-nour reviewed end to end',
   'Website, courses, a lesson, checkout and certificates on the demo academy, in English and Arabic.',
   NULL, false, NULL, 0, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'product', 'Pricing reviewed',
   'Plans, yearly prices and the founding offer match what the launch posts and emails say.',
   '/pricing', false, NULL, 1, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'product', 'Founding seats status reviewed',
   'Seats taken and remaining are correct before the launch traffic arrives.',
   '/founding', false, NULL, 2, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'content', 'Blog: the 11 launch posts published',
   'Every post published in English and Arabic, with covers, alt text and SEO fields.',
   '/dashboard/platform/blog', false, NULL, 3, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'content', '/resources page live',
   'The resources page is reachable in English and Arabic and linked from the header and footer.',
   '/resources', false, NULL, 4, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'content', '/solutions/multi-academy page live',
   'The multi-academy solution page is reachable in English and Arabic.',
   '/solutions/multi-academy', false, NULL, 5, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'content', 'Help center reviewed',
   'Articles a new academy owner needs on day one are current.',
   NULL, false, NULL, 6, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'marketing', 'Marketing banner prepared',
   'Launch banner written in English and Arabic, scheduled for launch day.',
   '/dashboard/platform/announcements', false, NULL, 7, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'marketing', 'Marketing pop-up prepared',
   'Launch pop-up written in English and Arabic, with its pages, delay and frequency set.',
   '/dashboard/platform/announcements', false, NULL, 8, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'marketing', 'Social posts scheduled',
   'Launch-week posts scheduled on every channel, linking to the blog and pricing.',
   NULL, false, NULL, 9, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'marketing', 'Search Console: blog sitemap submitted',
   'The blog sitemap is submitted and the launch posts are requested for indexing.',
   'https://search.google.com/search-console', false, NULL, 10, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'communication', 'Dashboard banner prepared',
   'The in-dashboard launch banner for existing customers, with its audience set.',
   '/dashboard/platform/announcements', false, NULL, 11, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'communication', 'Launch email drafted in Compose & Send',
   'English and Arabic versions drafted and previewed; audience counted.',
   NULL, false, NULL, 12, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'communication', 'Support coverage for launch week',
   'Who answers WhatsApp, email and contact requests each day of launch week.',
   NULL, false, NULL, 13, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'operations', 'StatusCake checks green',
   'Every uptime check passing, with alerts going to the on-call phone.',
   NULL, false, NULL, 14, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'operations', 'Restore drill done',
   'Database restore rehearsed from the latest backup.',
   NULL, true, TIMESTAMP '2026-10-26 00:00:00', 15, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'operations', 'Rollback plan reviewed',
   'How to roll back the backend, the dashboard and the marketing site, and who decides.',
   NULL, false, NULL, 16, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'operations', 'Launch-day monitoring owner assigned',
   'One person watches errors, payments and sign-ups on launch day.',
   NULL, false, NULL, 17, CURRENT_TIMESTAMP);
