-- ============================================================================
-- The organization OWNER is the implicit owner of every academy of the
-- organization — in the RLS helpers too.
--
-- `AcademyScopeGuard` (application layer) has resolved the organization
-- owner to academy role `owner` for every academy in the organization since
-- W5, with no `academy_members` row. The service-level checks now apply the
-- same rule (`AcademyMembersRepository.findManagingRole`). The RLS helpers
-- below still read `academy_members` only, so the owner of an academy that
-- has no staff row for them (a seeded academy, an academy created before
-- the owner's row existed, an organization whose ownership moved) passed
-- both application layers and was then refused by the database: e.g.
-- `website_configurations_insert` (is_academy_member) failed with 42501 on
-- the first read of the Website surface.
--
-- Rule: ONLY `organization_memberships.role = 'owner'` of the academy's own
-- organization. Organization managers and members get nothing new; they
-- still need an ACTIVE `academy_members` row, exactly as before.
--
-- Each helper is redefined with CREATE OR REPLACE: signature, LANGUAGE sql,
-- STABLE, SECURITY DEFINER and `search_path = public` are unchanged, so the
-- owner, the EXECUTE grants and every policy that calls them are untouched.
-- The only change is one extra `OR is_organization_owner_of_academy(...)`
-- branch. No data is read or written by this migration.
--
-- Not changed on purpose: `academy_notification_recipients` (who RECEIVES
-- staff notifications is not an authorization question).
--
-- Reversal: re-run the previous definitions — is_academy_member /
-- can_author_course_content from 20261104000341, is_academy_moderator from
-- 20260906000000, is_course_moderator from 20260907040000, can_review_course
-- / can_view_academy_student from 20261008000000, can_manage_academy_students
-- from 20261008000200, can_access_lesson from 20261009000000 — then
-- `DROP FUNCTION is_organization_owner_of_academy(text, text)`.
-- ============================================================================

CREATE OR REPLACE FUNCTION is_organization_owner_of_academy(p_academy_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "academies" a
    JOIN "organization_memberships" om ON om."organization_id" = a."organization_id"
    WHERE a."id" = p_academy_id
      AND om."user_id" = p_user_id
      AND om."role" = 'owner'
  );
$$;

REVOKE ALL ON FUNCTION is_organization_owner_of_academy(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_organization_owner_of_academy(text, text) TO "atlas_app";

CREATE OR REPLACE FUNCTION is_academy_member(p_academy_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM "academy_members"
      WHERE "academy_id" = p_academy_id
        AND "user_id" = p_user_id
        AND "status" = 'active'
    )
    OR is_organization_owner_of_academy(p_academy_id, p_user_id);
$$;

CREATE OR REPLACE FUNCTION is_academy_moderator(p_academy_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM "academy_members"
      WHERE "academy_id" = p_academy_id
        AND "user_id" = p_user_id
        AND "role" IN ('owner', 'administrator', 'manager')
    )
    OR is_organization_owner_of_academy(p_academy_id, p_user_id);
$$;

CREATE OR REPLACE FUNCTION can_manage_academy_students(p_academy_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM "academy_members" am
      WHERE am."academy_id" = p_academy_id
        AND am."user_id" = p_user_id
        AND am."status" = 'active'
        AND am."role" IN ('owner', 'administrator', 'manager')
    )
    OR is_organization_owner_of_academy(p_academy_id, p_user_id);
$$;

CREATE OR REPLACE FUNCTION can_view_academy_student(p_academy_id text, p_student_user_id text, p_viewer_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM "academy_members" am
      WHERE am."academy_id" = p_academy_id
        AND am."user_id" = p_viewer_id
        AND am."status" = 'active'
        AND am."role" IN ('owner', 'administrator', 'manager')
    )
    OR EXISTS (
      SELECT 1 FROM "enrollments" e
      JOIN "course_instructors" ci ON ci."course_id" = e."course_id"
      WHERE e."academy_id" = p_academy_id
        AND e."student_id" = p_student_user_id
        AND ci."user_id" = p_viewer_id
    )
    OR is_organization_owner_of_academy(p_academy_id, p_viewer_id);
$$;

CREATE OR REPLACE FUNCTION can_author_course_content(p_course_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM "course_instructors"
      WHERE "course_id" = p_course_id AND "user_id" = p_user_id
    )
    OR EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academy_members" am ON am."academy_id" = c."academy_id"
      WHERE c."id" = p_course_id
        AND am."user_id" = p_user_id
        AND am."status" = 'active'
        AND am."role" IN ('owner', 'administrator', 'manager')
    )
    OR EXISTS (
      SELECT 1 FROM "courses" c
      WHERE c."id" = p_course_id
        AND is_organization_owner_of_academy(c."academy_id", p_user_id)
    );
$$;

CREATE OR REPLACE FUNCTION can_review_course(p_course_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM "course_instructors"
      WHERE "course_id" = p_course_id AND "user_id" = p_user_id
    )
    OR EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academy_members" am ON am."academy_id" = c."academy_id"
      WHERE c."id" = p_course_id
        AND am."user_id" = p_user_id
        AND am."status" = 'active'
        AND am."role" IN ('owner', 'administrator', 'manager')
    )
    OR EXISTS (
      SELECT 1 FROM "courses" c
      WHERE c."id" = p_course_id
        AND is_organization_owner_of_academy(c."academy_id", p_user_id)
    );
$$;

CREATE OR REPLACE FUNCTION is_course_moderator(p_course_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM "course_instructors"
      WHERE "course_id" = p_course_id AND "user_id" = p_user_id
    )
    OR EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academy_members" am ON am."academy_id" = c."academy_id"
      WHERE c."id" = p_course_id
        AND am."user_id" = p_user_id
        AND am."role" IN ('owner', 'administrator', 'manager')
    )
    OR EXISTS (
      SELECT 1 FROM "courses" c
      WHERE c."id" = p_course_id
        AND is_organization_owner_of_academy(c."academy_id", p_user_id)
    );
$$;

CREATE OR REPLACE FUNCTION can_access_lesson(p_lesson_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    -- preview on a published course — no identity required
    SELECT 1
    FROM "course_lessons" l
    JOIN "courses" c ON c."id" = l."course_id"
    WHERE l."id" = p_lesson_id
      AND l."is_preview" = true
      AND l."status" = 'published'
      AND c."status" = 'published'
  )
  OR (
    p_user_id IS NOT NULL AND p_user_id <> ''
    AND (
      EXISTS (
        -- Active enrollment, published course, deliverable lesson
        -- (`isEnrollmentActive()` + `assertActiveEnrollment` condition 7).
        SELECT 1
        FROM "course_lessons" l
        JOIN "courses" c ON c."id" = l."course_id"
        JOIN "enrollments" e ON e."course_id" = l."course_id"
        WHERE l."id" = p_lesson_id
          AND l."status" = 'published'
          AND c."status" = 'published'
          AND e."student_id" = p_user_id
          AND e."status" IN ('enrolled', 'completed')
          AND e."revoked_at" IS NULL
          AND (e."expires_at" IS NULL OR e."expires_at" > now())
          AND (l."available_at" IS NULL OR l."available_at" <= now())
          AND is_academy_student(c."academy_id", p_user_id)
      )
      OR EXISTS (
        -- course instructor
        SELECT 1
        FROM "course_lessons" l
        JOIN "course_instructors" ci ON ci."course_id" = l."course_id"
        WHERE l."id" = p_lesson_id
          AND ci."user_id" = p_user_id
      )
      OR EXISTS (
        -- academy owner / administrator / manager
        SELECT 1
        FROM "course_lessons" l
        JOIN "courses" c ON c."id" = l."course_id"
        JOIN "academy_members" am ON am."academy_id" = c."academy_id"
        WHERE l."id" = p_lesson_id
          AND am."user_id" = p_user_id
          AND am."status" = 'active'
          AND am."role" IN ('owner', 'administrator', 'manager')
      )
      OR EXISTS (
        -- the organization owner (implicit owner of every academy)
        SELECT 1
        FROM "course_lessons" l
        JOIN "courses" c ON c."id" = l."course_id"
        WHERE l."id" = p_lesson_id
          AND is_organization_owner_of_academy(c."academy_id", p_user_id)
      )
    )
  );
$$;
