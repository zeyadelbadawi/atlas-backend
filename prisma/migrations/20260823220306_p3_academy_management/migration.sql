-- CreateEnum
CREATE TYPE "academy_status" AS ENUM ('draft', 'active', 'suspended', 'archived');

-- CreateEnum
CREATE TYPE "academy_member_role" AS ENUM ('owner', 'administrator', 'manager', 'instructor', 'staff');

-- CreateEnum
CREATE TYPE "academy_member_status" AS ENUM ('active', 'inactive', 'pending');

-- CreateTable
CREATE TABLE "academies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "logo_url" TEXT,
    "favicon_url" TEXT,
    "status" "academy_status" NOT NULL DEFAULT 'draft',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "language" TEXT NOT NULL DEFAULT 'en',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "contact_email" TEXT,
    "contact_phone" TEXT,
    "website_url" TEXT,
    "address" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "academies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academy_members" (
    "id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "academy_member_role" NOT NULL,
    "status" "academy_member_status" NOT NULL DEFAULT 'active',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academy_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "academies_slug_key" ON "academies"("slug");

-- CreateIndex
CREATE INDEX "academies_organization_id_status_idx" ON "academies"("organization_id", "status");

-- CreateIndex
CREATE INDEX "academy_members_academy_id_idx" ON "academy_members"("academy_id");

-- CreateIndex
CREATE INDEX "academy_members_user_id_idx" ON "academy_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "academy_members_academy_id_user_id_key" ON "academy_members"("academy_id", "user_id");

-- AddForeignKey
ALTER TABLE "academies" ADD CONSTRAINT "academies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy_members" ADD CONSTRAINT "academy_members_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy_members" ADD CONSTRAINT "academy_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security (master plan §7, §17: "a table must never exist, even
-- briefly, without its RLS policy in the same deploy").
--
-- Tenant ownership is resolved TRANSITIVELY, not via a new session variable:
--   academies           -> organization_id (direct column)
--   academy_members     -> academies.organization_id (via EXISTS join)
-- Both ultimately compare against `app.current_organization_id` — the exact
-- same session variable P2 established, set the exact same way
-- (`TenancyContextService.runInTenantContext`, `set_config(..., true)`,
-- transaction-scoped). No `app.current_academy_id` is introduced: nothing in
-- this schema needs a narrower context than "the active organization," since
-- every Academy operation (list/detail/create/update/branding/members/
-- stats/activity) is already scoped to one active organization at the
-- controller/guard layer before it ever reaches the repository — mirroring
-- the frontend's own `AcademyService`/`academyKeys`, where every call and
-- every query key embeds `organizationId`.
--
-- Deliberately NOT reusing `app.current_user_id` here: that variable is only
-- ever set by `TenancyContextService.runInUserContext`, a distinct code path
-- used solely for P2's "list my own organizations across tenants" case
-- (sign-in, `GET /users/me`). No Academy operation runs in user-context —
-- every one runs in tenant-context (`runInTenantContext`), where
-- `app.current_user_id` is simply unset. Writing a policy that depended on
-- it here would silently and permanently deny every Academy write, not add
-- security. See `TenancyContextService` — the two context methods are
-- mutually exclusive per transaction, by design.
--
-- `FORCE ROW LEVEL SECURITY` for the same reason as P2: the migration role
-- owns these tables, and Postgres exempts owners from RLS unless FORCED.
--
-- Command coverage, deliberate:
--   SELECT — tenant-scoped, transitively for `academy_members`. This is what
--     the P3-TENANT-001..010 suite exists to prove.
--   INSERT — narrow, NOT `WITH CHECK (true)` (the exact anti-pattern P2's
--     review caught and corrected — see
--     `20260823184500_p2_narrow_insert_rls_policies`). `academies_insert`
--     requires the new row's `organization_id` to equal the caller's
--     already-verified active tenant context — the row cannot be created
--     "in" any organization other than the one the session has established,
--     regardless of what a buggy or unreviewed code path passes as a
--     column value. `academy_members_insert` requires the target
--     `academy_id` to resolve (via the same EXISTS-join used for SELECT) to
--     an academy inside the caller's active tenant context — the same
--     tenant boundary, extended one hop. Neither policy restricts WHICH
--     user may be named `user_id`/who may perform the insert — that is a
--     role-based authorization question (e.g. only an Academy
--     owner/administrator may add a member) handled at the service/guard
--     layer, exactly as P2 left analogous role questions to the
--     application layer; RLS's job here is the tenant boundary, not role
--     authorization. In P3's actual scope, the only INSERT this policy
--     needs to admit is the automatic owner-membership row created in the
--     same transaction as `POST /academies` (the creator becomes the
--     Academy's first `owner`-role member) — there is no standalone
--     "add member" endpoint in P3.
--   UPDATE — no policy on either table. `academies` updates (name,
--     branding, status, ...) are implemented as ordinary tenant-scoped
--     writes performed by the service layer using the same
--     `runInTenantContext` transaction client Prisma issues the UPDATE
--     through; Postgres RLS still requires an explicit UPDATE policy to
--     permit that. Deliberately omitted for THIS migration: no P3 endpoint
--     changes `organization_id` on an existing Academy row (master plan
--     instruction: "Never allow organization_id to be reassigned through a
--     normal Academy update") and no P3 endpoint updates `academy_members`
--     at all (no role-change/status-change endpoint exists in this phase).
--     An UPDATE policy scoped to non-tenant-changing columns is added when
--     the `PATCH /academies/:id` service path is implemented, in the same
--     migration that adds it — matching §17's "policy lands with the
--     capability" rule, not ahead of it.
--   DELETE — no policy on either table, and none planned. `DELETE
--     /academies/:id` (the frontend's real, defined contract) is
--     implemented as a status transition to `archived` — an UPDATE, never a
--     SQL DELETE — matching `organizations`' own no-hard-delete precedent.
--     Omitting the DELETE policy makes hard deletion impossible at the
--     database level even if application code attempted it.
-- ============================================================================

ALTER TABLE "academies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "academies" FORCE ROW LEVEL SECURITY;

CREATE POLICY "academies_tenant_select" ON "academies"
  FOR SELECT
  USING ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "academies_insert" ON "academies"
  FOR INSERT
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));

ALTER TABLE "academy_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "academy_members" FORCE ROW LEVEL SECURITY;

CREATE POLICY "academy_members_tenant_select" ON "academy_members"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "academy_members"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "academy_members_insert" ON "academy_members"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "academy_members"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );
