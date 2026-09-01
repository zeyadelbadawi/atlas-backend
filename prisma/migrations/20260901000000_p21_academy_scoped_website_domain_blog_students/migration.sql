-- ============================================================================
-- Phase 1 (Extended Scope, Decision 11, dependencies A + D) — Academy-scoped
-- authorization boundary for website/domain resources, and a real,
-- Academy-scoped Student identity.
--
-- Confirmed product architecture: ONE INDEPENDENT PUBLIC WEBSITE PER
-- ACADEMY, never one shared Organization-level website. Concretely, this
-- migration closes two separate gaps discovered against that requirement:
--
--   GAP A — `website_configurations`/`website_pages`/`website_faq_entries`/
--   `website_testimonial_entries`/`subdomain_allocations`/
--   `domain_connections` RLS policies all key on
--   `a.organization_id = app.current_organization_id` alone. A Manager
--   assigned to Academy A (via `academy_members`) could read/write Academy
--   B's website/domain rows purely because both share an Organization —
--   the same defect the P3 `AcademyScopeGuard` already has at the
--   application layer for READS (WRITES were already correctly narrowed:
--   `WebsiteConfigurationService`/`WebsitePagesService`/
--   `WebsiteContentService`/`DomainService` all already call an
--   `assertCanManage` requiring a real `academy_members` row with an
--   `owner`/`administrator`/`manager` role — see those services' own doc
--   comments; this migration's RLS change is the matching database-layer
--   backstop for that same rule, plus the missing application-layer
--   `assertIsMember` check now added to every read method).
--
--   GAP D — a Student has no real Academy identity at all today
--   (`AcademiesService.createStudent`'s own doc comment: "a student is
--   never an `academy_members` row"). `academy_students` (new table below)
--   is the fix — structurally parallel to `academy_members`, but a
--   separate table/role-less concept (`AcademyMemberRole` has no
--   `student` value and is reserved for staff). Both self-registration
--   (`AuthService.register`, once a public Academy website's Sign Up page
--   supplies an academy context) and staff-created students
--   (`AcademiesService.createStudent`) populate it going forward; existing
--   enrollments are backfilled below so no current student loses access.
--
-- Reused, not reinvented: `is_academy_member` (P7) is the exact existing
-- `SECURITY DEFINER` pattern this migration's new `is_academy_student`
-- mirrors, and the six website/domain tables' policy rewrites reuse that
-- same existing function rather than introducing a parallel check.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PART 1 — `academy_students` (dependency D)
-- ----------------------------------------------------------------------------

CREATE TABLE "academy_students" (
    "id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "academy_member_status" NOT NULL DEFAULT 'active',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academy_students_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "academy_students_academy_id_idx" ON "academy_students"("academy_id");

CREATE INDEX "academy_students_user_id_idx" ON "academy_students"("user_id");

CREATE UNIQUE INDEX "academy_students_academy_id_user_id_key" ON "academy_students"("academy_id", "user_id");

ALTER TABLE "academy_students" ADD CONSTRAINT "academy_students_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "academy_students" ADD CONSTRAINT "academy_students_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "academy_students" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "academy_students" FORCE ROW LEVEL SECURITY;

-- A student reading their own home-academy membership (no tenant context
-- needed — mirrors `enrollments_self_select`'s own `runInUserContext` shape).
CREATE POLICY "academy_students_self_select" ON "academy_students"
  FOR SELECT
  USING ("academy_students"."user_id"::text = current_setting('app.current_user_id', true));

-- Self-registration (`AuthService.register`) — runs under
-- `runInUserContext` (only `app.current_user_id` set, no tenant context
-- yet: this IS the step that gives the brand-new user their first tenant
-- fact), so this is deliberately the one INSERT policy on this table that
-- does not also require a tenant context to be open.
CREATE POLICY "academy_students_self_insert" ON "academy_students"
  FOR INSERT
  WITH CHECK ("academy_students"."user_id"::text = current_setting('app.current_user_id', true));

-- Staff-created students (`AcademiesService.createStudent`) — runs under
-- `runInTenantAndUserContext`; mirrors `academy_members_insert`'s own
-- shape exactly (tenant-scoped, the specific owner/administrator/manager
-- role check already happens in the application layer before this INSERT
-- is attempted, exactly like every other staff-grant path in this schema).
CREATE POLICY "academy_students_staff_insert" ON "academy_students"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "academy_students"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

-- Academy staff (any real role) can see their own Academy's student
-- roster — mirrors `academies_academy_member_select`'s "any real
-- membership" precedent; matches `AcademiesService.getStats`'s own
-- tenant-context read shape.
CREATE POLICY "academy_students_staff_select" ON "academy_students"
  FOR SELECT
  USING (is_academy_member("academy_students"."academy_id", current_setting('app.current_user_id', true)));

/** Mirrors `is_academy_member` (P7) exactly, for the new, separate `academy_students` table — see this migration's own header comment for why Students are not folded into `academy_members`. */
CREATE FUNCTION is_academy_student(p_academy_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "academy_students"
    WHERE "academy_id" = p_academy_id AND "user_id" = p_user_id
  );
$$;

-- Backfill: every (student, academy) pair already implied by an existing
-- enrollment becomes a real `academy_students` row, so no student who is
-- already legitimately using the product loses access once
-- `enrollments_self_insert` (below) starts requiring this row to exist.
-- `ON CONFLICT DO NOTHING` — a student enrolled in several courses at the
-- same Academy collapses to exactly one membership row, matching this
-- table's own unique constraint.
INSERT INTO "academy_students" ("id", "academy_id", "user_id", "status", "joined_at")
SELECT gen_random_uuid()::text, e."academy_id", e."student_id", 'active', MIN(e."created_at")
FROM "enrollments" e
GROUP BY e."academy_id", e."student_id"
ON CONFLICT ("academy_id", "user_id") DO NOTHING;

-- ----------------------------------------------------------------------------
-- PART 2 — `enrollments` (dependency D) — the actual isolation closure:
-- a student may only ENROLL into a course owned by an Academy they hold a
-- real `academy_students` row for. `SELECT`/`UPDATE` stay unchanged
-- (already correctly self-scoped, and reading/updating one's OWN existing
-- enrollment row leaks nothing cross-academy) — only the one policy that
-- lets a student join a NEW academy's course needs the extra check.
-- ----------------------------------------------------------------------------

DROP POLICY "enrollments_self_insert" ON "enrollments";

CREATE POLICY "enrollments_self_insert" ON "enrollments"
  FOR INSERT
  WITH CHECK (
    "enrollments"."student_id"::text = current_setting('app.current_user_id', true)
    AND is_academy_student("enrollments"."academy_id", current_setting('app.current_user_id', true))
  );

-- ----------------------------------------------------------------------------
-- PART 3 — website/domain tables (dependency A) — every existing policy
-- keyed on organization membership alone now ALSO requires the caller to
-- be a real `academy_members` row for THIS SPECIFIC academy (any role —
-- the application layer already narrows further, per-action, to the
-- specific managing roles; this is the RLS backstop, not a second copy of
-- that role check). Organization-level tenant isolation (the
-- `a.organization_id = app.current_organization_id` clause) is preserved
-- unchanged in every policy below — this narrows within an organization,
-- it does not replace the existing cross-organization boundary.
-- ----------------------------------------------------------------------------

-- website_configurations
DROP POLICY "website_configurations_tenant_select" ON "website_configurations";
DROP POLICY "website_configurations_insert" ON "website_configurations";
DROP POLICY "website_configurations_tenant_update" ON "website_configurations";

CREATE POLICY "website_configurations_tenant_select" ON "website_configurations"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_configurations"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "website_configurations_insert" ON "website_configurations"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_configurations"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "website_configurations_tenant_update" ON "website_configurations"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_configurations"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_configurations"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

-- website_pages
DROP POLICY "website_pages_tenant_select" ON "website_pages";
DROP POLICY "website_pages_insert" ON "website_pages";
DROP POLICY "website_pages_tenant_update" ON "website_pages";
DROP POLICY "website_pages_tenant_delete" ON "website_pages";

CREATE POLICY "website_pages_tenant_select" ON "website_pages"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_pages"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "website_pages_insert" ON "website_pages"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_pages"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "website_pages_tenant_update" ON "website_pages"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_pages"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_pages"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "website_pages_tenant_delete" ON "website_pages"
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_pages"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

-- website_faq_entries
DROP POLICY "website_faq_entries_tenant_select" ON "website_faq_entries";
DROP POLICY "website_faq_entries_insert" ON "website_faq_entries";
DROP POLICY "website_faq_entries_tenant_update" ON "website_faq_entries";

CREATE POLICY "website_faq_entries_tenant_select" ON "website_faq_entries"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_faq_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "website_faq_entries_insert" ON "website_faq_entries"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_faq_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "website_faq_entries_tenant_update" ON "website_faq_entries"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_faq_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_faq_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

-- website_testimonial_entries
DROP POLICY "website_testimonial_entries_tenant_select" ON "website_testimonial_entries";
DROP POLICY "website_testimonial_entries_insert" ON "website_testimonial_entries";
DROP POLICY "website_testimonial_entries_tenant_update" ON "website_testimonial_entries";

CREATE POLICY "website_testimonial_entries_tenant_select" ON "website_testimonial_entries"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_testimonial_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "website_testimonial_entries_insert" ON "website_testimonial_entries"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_testimonial_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "website_testimonial_entries_tenant_update" ON "website_testimonial_entries"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_testimonial_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_testimonial_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

-- subdomain_allocations
DROP POLICY "subdomain_allocations_tenant_select" ON "subdomain_allocations";
DROP POLICY "subdomain_allocations_insert" ON "subdomain_allocations";
DROP POLICY "subdomain_allocations_tenant_update" ON "subdomain_allocations";

CREATE POLICY "subdomain_allocations_tenant_select" ON "subdomain_allocations"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "subdomain_allocations"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "subdomain_allocations_insert" ON "subdomain_allocations"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "subdomain_allocations"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "subdomain_allocations_tenant_update" ON "subdomain_allocations"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "subdomain_allocations"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "subdomain_allocations"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

-- domain_connections
DROP POLICY "domain_connections_tenant_select" ON "domain_connections";
DROP POLICY "domain_connections_insert" ON "domain_connections";
DROP POLICY "domain_connections_tenant_update" ON "domain_connections";

CREATE POLICY "domain_connections_tenant_select" ON "domain_connections"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "domain_connections"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "domain_connections_insert" ON "domain_connections"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "domain_connections"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "domain_connections_tenant_update" ON "domain_connections"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "domain_connections"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "domain_connections"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

-- ----------------------------------------------------------------------------
-- PART 4 — `blog_posts` write policies (dependency B) — an author may only
-- insert/keep a post whose `academy_id` is an Academy they are actually a
-- member of (or NULL, for a platform-level post). `author_id = current
-- user` remains the primary check (unchanged, deliberately narrower than
-- `announcements` per this table's own pre-existing doc comment — no
-- academy-staff override); this is an ADDITIONAL narrowing, not a
-- replacement, so a revoked academy membership also revokes the ability
-- to keep authoring/editing that academy's posts.
-- ----------------------------------------------------------------------------

DROP POLICY "blog_posts_author_insert" ON "blog_posts";
DROP POLICY "blog_posts_author_update" ON "blog_posts";
DROP POLICY "blog_posts_author_delete" ON "blog_posts";

CREATE POLICY "blog_posts_author_insert" ON "blog_posts"
  FOR INSERT
  WITH CHECK (
    "blog_posts"."author_id"::text = current_setting('app.current_user_id', true)
    AND (
      "blog_posts"."academy_id" IS NULL
      OR is_academy_member("blog_posts"."academy_id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "blog_posts_author_update" ON "blog_posts"
  FOR UPDATE
  USING (
    "blog_posts"."author_id"::text = current_setting('app.current_user_id', true)
    AND (
      "blog_posts"."academy_id" IS NULL
      OR is_academy_member("blog_posts"."academy_id", current_setting('app.current_user_id', true))
    )
  )
  WITH CHECK (
    "blog_posts"."author_id"::text = current_setting('app.current_user_id', true)
    AND (
      "blog_posts"."academy_id" IS NULL
      OR is_academy_member("blog_posts"."academy_id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "blog_posts_author_delete" ON "blog_posts"
  FOR DELETE
  USING (
    "blog_posts"."author_id"::text = current_setting('app.current_user_id', true)
    AND (
      "blog_posts"."academy_id" IS NULL
      OR is_academy_member("blog_posts"."academy_id", current_setting('app.current_user_id', true))
    )
  );
