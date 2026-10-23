-- =============================================================================
-- CMS phase 4 — page version history, and the header/footer lock.
-- ADDITIVE ONLY: one new enum type, one new table, one new column on
-- `website_configurations`; nothing existing is altered or dropped.
--
-- `website_page_versions`: immutable copies of a page's editable content
-- (title, slug, visibility, SEO, sections), written by the server on every
-- publish, at most once per 10 minutes of draft saves, and just before a
-- restore (so a restore is itself undoable). The newest 30 per page are
-- kept; the insert's own transaction prunes the rest. Rows go with their
-- page and academy (ON DELETE CASCADE); the author is kept as NULL when the
-- user is deleted.
--
-- RLS mirrors `website_pages` (p21): a row is visible to and writable by
-- members of its academy in the current organization. No UPDATE policy —
-- a version is never rewritten. DELETE is the retention prune. Grants come
-- from the p2 default privileges for `atlas_app`.
--
-- `website_configurations.chrome_locked`: when true, a configuration save
-- that would change the header, footer or navigation menu is refused. A
-- constant default is a metadata-only change on PostgreSQL 11+.
--
-- Idempotent, so applying it twice is harmless.
--
-- Rollback (loses only the history and the lock flag):
--   DROP TABLE IF EXISTS "website_page_versions";
--   DROP TYPE IF EXISTS "website_page_version_kind";
--   ALTER TABLE "website_configurations" DROP COLUMN IF EXISTS "chrome_locked";
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE "website_page_version_kind" AS ENUM ('published', 'draft_snapshot', 'restore_backup');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "website_page_versions" (
    "id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "kind" "website_page_version_kind" NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "visible" BOOLEAN NOT NULL,
    "seo" JSONB NOT NULL,
    "sections" JSONB NOT NULL,
    "source_version" INTEGER NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_page_versions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "website_page_versions_page_id_created_at_idx"
  ON "website_page_versions"("page_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "website_page_versions_academy_id_idx"
  ON "website_page_versions"("academy_id");

DO $$ BEGIN
  ALTER TABLE "website_page_versions"
    ADD CONSTRAINT "website_page_versions_academy_id_fkey"
    FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "website_page_versions"
    ADD CONSTRAINT "website_page_versions_page_id_fkey"
    FOREIGN KEY ("page_id") REFERENCES "website_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "website_page_versions"
    ADD CONSTRAINT "website_page_versions_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "website_page_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "website_page_versions" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "website_page_versions_tenant_select" ON "website_page_versions";
CREATE POLICY "website_page_versions_tenant_select" ON "website_page_versions"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_page_versions"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

DROP POLICY IF EXISTS "website_page_versions_insert" ON "website_page_versions";
CREATE POLICY "website_page_versions_insert" ON "website_page_versions"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_page_versions"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

DROP POLICY IF EXISTS "website_page_versions_tenant_delete" ON "website_page_versions";
CREATE POLICY "website_page_versions_tenant_delete" ON "website_page_versions"
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_page_versions"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

ALTER TABLE "website_configurations"
  ADD COLUMN IF NOT EXISTS "chrome_locked" BOOLEAN NOT NULL DEFAULT false;
