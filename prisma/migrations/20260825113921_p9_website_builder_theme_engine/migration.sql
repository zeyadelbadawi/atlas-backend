-- CreateEnum
CREATE TYPE "website_publish_status" AS ENUM ('draft', 'published', 'publishing', 'failed');

-- CreateEnum
CREATE TYPE "website_page_type" AS ENUM ('core', 'custom');

-- CreateEnum
CREATE TYPE "website_core_page_type" AS ENUM ('home', 'about', 'courses', 'faqs', 'contact', 'courseDetails');

-- CreateTable
CREATE TABLE "website_configurations" (
    "academy_id" TEXT NOT NULL,
    "theme_key" TEXT NOT NULL,
    "theme_version" INTEGER NOT NULL,
    "config_version" INTEGER NOT NULL DEFAULT 1,
    "brand" JSONB NOT NULL,
    "seo" JSONB NOT NULL,
    "navigation" JSONB NOT NULL,
    "header" JSONB NOT NULL,
    "footer" JSONB NOT NULL,
    "status" "website_publish_status" NOT NULL DEFAULT 'draft',
    "published_at" TIMESTAMP(3),
    "last_publish_error" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "website_configurations_pkey" PRIMARY KEY ("academy_id")
);

-- CreateTable
CREATE TABLE "website_pages" (
    "id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "page_type" "website_page_type" NOT NULL,
    "core_type" "website_core_page_type",
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "seo" JSONB NOT NULL,
    "sections" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "website_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "website_pages_academy_id_page_type_idx" ON "website_pages"("academy_id", "page_type");

-- CreateIndex
CREATE UNIQUE INDEX "website_pages_academy_id_slug_key" ON "website_pages"("academy_id", "slug");

-- AddForeignKey
ALTER TABLE "website_configurations" ADD CONSTRAINT "website_configurations_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_pages" ADD CONSTRAINT "website_pages_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- P9 Row-Level Security (master plan §5.10/§7/§21 Phase P9).
--
-- Academy-scoped, resolved transitively (`*.academy_id → academies.
-- organization_id`), reusing the exact P5 `courses`/P8 `media_assets`
-- shape and session variable (`app.current_organization_id`) — no new
-- tenancy mechanism. `AcademyScopeGuard` (reused verbatim, unmodified)
-- resolves and re-verifies organization membership before any of these
-- policies matter; RLS is the independent second layer underneath it.
--
-- `website_configurations`: SELECT/INSERT/UPDATE only, matching `courses`'/
-- `media_assets`' precedent — the row is created once (lazily, on first
-- read) and then only ever updated in place; there is no delete endpoint
-- anywhere in the real `WebsiteConfigurationService` contract, and the
-- `ON DELETE CASCADE` FK to `academies` is the only removal path (an
-- Academy being deleted), which runs as the migration owner, not under
-- RLS.
--
-- `website_pages`: SELECT/INSERT/UPDATE/DELETE. Unlike `courses`/
-- `media_assets`, this table gets a real DELETE policy — direct inspection
-- of the actual frontend (`WebsiteConfigurationService.deletePage`,
-- `useDeleteWebsitePage.ts`) proves a genuine hard-delete capability exists
-- for custom pages, a deliberate departure from the archive-only
-- convention established elsewhere. The RLS policy enforces only the
-- tenant boundary (an organization can never delete another
-- organization's page); the core-vs-custom distinction (a core page must
-- never be deletable) is enforced at the application/service layer
-- (`WebsitePagesService.deletePage`), exactly like every other
-- business-rule check in this codebase that RLS does not and should not
-- encode.
-- ============================================================================

ALTER TABLE "website_configurations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "website_configurations" FORCE ROW LEVEL SECURITY;

CREATE POLICY "website_configurations_tenant_select" ON "website_configurations"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_configurations"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "website_configurations_insert" ON "website_configurations"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_configurations"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "website_configurations_tenant_update" ON "website_configurations"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_configurations"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_configurations"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

ALTER TABLE "website_pages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "website_pages" FORCE ROW LEVEL SECURITY;

CREATE POLICY "website_pages_tenant_select" ON "website_pages"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_pages"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "website_pages_insert" ON "website_pages"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_pages"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "website_pages_tenant_update" ON "website_pages"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_pages"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_pages"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "website_pages_tenant_delete" ON "website_pages"
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_pages"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );
