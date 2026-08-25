-- CreateEnum
CREATE TYPE "media_asset_type" AS ENUM ('image', 'video', 'document', 'other');

-- CreateEnum
CREATE TYPE "media_asset_status" AS ENUM ('active', 'archived');

-- CreateTable
CREATE TABLE "media_assets" (
    "id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "type" "media_asset_type" NOT NULL,
    "status" "media_asset_status" NOT NULL DEFAULT 'active',
    "file_name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "alt_text" TEXT,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_assets_academy_id_status_type_idx" ON "media_assets"("academy_id", "status", "type");

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- P8 Row-Level Security (master plan §5.9/§7/§13, §21 Phase P8).
--
-- Academy-scoped, resolved transitively (`media_assets.academy_id →
-- academies.organization_id`), reusing the exact P5 `courses` shape and
-- session variable (`app.current_organization_id`) — no new tenancy
-- mechanism. `AcademyScopeGuard` (reused verbatim from `AcademyModule`,
-- unmodified — the same guard `CoursesController` already reuses)
-- resolves and re-verifies organization membership before any of these
-- policies matter; RLS is the independent second layer underneath it,
-- not the only one.
--
-- Command coverage: SELECT/INSERT/UPDATE — matches `courses`' own P5
-- precedent (transitive tenant check on every command). No DELETE policy
-- at all: media has no hard-delete endpoint anywhere in `MediaService`
-- (archive-only lifecycle, `status = 'archived'`, master plan §13) —
-- denied by default, matching `courses`' identical "no DELETE policy"
-- precedent for the same reason.
-- ============================================================================

ALTER TABLE "media_assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "media_assets" FORCE ROW LEVEL SECURITY;

CREATE POLICY "media_assets_tenant_select" ON "media_assets"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "media_assets"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "media_assets_insert" ON "media_assets"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "media_assets"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "media_assets_tenant_update" ON "media_assets"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "media_assets"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "media_assets"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );
