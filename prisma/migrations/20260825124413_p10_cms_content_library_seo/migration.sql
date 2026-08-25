-- CreateEnum
CREATE TYPE "website_content_status" AS ENUM ('draft', 'published', 'archived');

-- CreateTable
CREATE TABLE "website_faq_entries" (
    "id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "question" JSONB NOT NULL,
    "answer" JSONB NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "status" "website_content_status" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "website_faq_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_testimonial_entries" (
    "id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "quote" JSONB NOT NULL,
    "author_name" TEXT NOT NULL,
    "author_role" JSONB,
    "avatar" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "status" "website_content_status" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "website_testimonial_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "website_faq_entries_academy_id_status_idx" ON "website_faq_entries"("academy_id", "status");

-- CreateIndex
CREATE INDEX "website_faq_entries_academy_id_order_idx" ON "website_faq_entries"("academy_id", "order");

-- CreateIndex
CREATE INDEX "website_testimonial_entries_academy_id_status_idx" ON "website_testimonial_entries"("academy_id", "status");

-- CreateIndex
CREATE INDEX "website_testimonial_entries_academy_id_order_idx" ON "website_testimonial_entries"("academy_id", "order");

-- AddForeignKey
ALTER TABLE "website_faq_entries" ADD CONSTRAINT "website_faq_entries_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_testimonial_entries" ADD CONSTRAINT "website_testimonial_entries_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- P10 Row-Level Security (master plan §5.10/§7/§21 Phase P10).
--
-- Academy-scoped, resolved transitively (`*.academy_id → academies.
-- organization_id`), reusing the exact P5 `courses`/P8 `media_assets`/P9
-- `website_configurations` shape and session variable
-- (`app.current_organization_id`) — no new tenancy mechanism.
-- `AcademyScopeGuard` (reused verbatim, unmodified) resolves and
-- re-verifies organization membership before any of these policies
-- matter; RLS is the independent second layer underneath it.
--
-- SELECT/INSERT/UPDATE only on both tables — matching `courses`/
-- `media_assets`' precedent, NOT P9's `website_pages` DELETE departure:
-- there is no hard-delete capability anywhere in the real
-- `WebsiteContentService` contract (archive is the one, terminal,
-- non-destructive removal action) — denied by default, matching every
-- other archive-only table's identical "no DELETE policy" precedent.
-- ============================================================================

ALTER TABLE "website_faq_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "website_faq_entries" FORCE ROW LEVEL SECURITY;

CREATE POLICY "website_faq_entries_tenant_select" ON "website_faq_entries"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_faq_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "website_faq_entries_insert" ON "website_faq_entries"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_faq_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "website_faq_entries_tenant_update" ON "website_faq_entries"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_faq_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_faq_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

ALTER TABLE "website_testimonial_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "website_testimonial_entries" FORCE ROW LEVEL SECURITY;

CREATE POLICY "website_testimonial_entries_tenant_select" ON "website_testimonial_entries"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_testimonial_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "website_testimonial_entries_insert" ON "website_testimonial_entries"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_testimonial_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "website_testimonial_entries_tenant_update" ON "website_testimonial_entries"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_testimonial_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_testimonial_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );
