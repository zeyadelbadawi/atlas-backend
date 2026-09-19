-- ============================================================================
-- P64 Phase 1 — missing `courses` SELECT tier for the enrolled student.
--
-- Found by browser/API validation, not by a unit test: a Client Owner used
-- the new roster drawer to enrol a learner manually into a course that is
-- `draft`/`private` (exactly what "give this student access without a
-- purchase" is for), and the learner's own `GET /enrollments` then failed
-- with HTTP 500 —
--
--   Inconsistent query result: Field course is required to return data,
--   got `null` instead.
--
-- The enrollment row itself is visible to the student (`enrollments_self_
-- select`), but `courses` had only four SELECT tiers: public discovery
-- (published AND public), academy participant (`academy_members` — staff,
-- not students), course instructor, tenant, and platform owner. A student
-- is none of those, so the required `course` relation came back NULL and
-- Prisma refused the result. Until now every student enrollment in local
-- data happened to point at a published+public course, which is why the
-- gap stayed invisible.
--
-- This adds the missing tier and nothing more: a student may SELECT a
-- course they hold an enrollment row for. Deliberately NOT restricted to
-- the active statuses, because the learner's list must also render the
-- revoked/expired/completed rows that P64 Phase 1 introduced — showing a
-- learner the title of a course whose access has ended is the point of
-- those states. Course *content* is unaffected: `course_sections`,
-- `course_lessons`, `quizzes` and `assignments` keep their own
-- `..._enrolled_select` tiers restricted to `enrolled`/`completed`, and
-- the application layer's `assertActiveEnrollment` additionally requires
-- unrevoked, unexpired and an active, unblocked academy membership.
--
-- The inline EXISTS is safe here for the same reason the existing
-- `course_lessons_enrolled_select` is: it reads `enrollments` as the
-- invoking role, and the only enrollment rows a student can see are their
-- own, so the subquery cannot be widened by another tier. (Contrast
-- `quiz_belongs_to_organization` in `20261008000400`, where the subquery
-- had to cross into rows the caller may legitimately not see.)
-- ============================================================================

DROP POLICY IF EXISTS "courses_enrolled_student_select" ON "courses";
CREATE POLICY "courses_enrolled_student_select" ON "courses"
  FOR SELECT
  USING (
    current_setting('app.current_user_id', true) IS NOT NULL
    AND current_setting('app.current_user_id', true) <> ''
    AND EXISTS (
      SELECT 1
      FROM "enrollments" e
      WHERE e."course_id" = "courses"."id"
        AND e."student_id" = current_setting('app.current_user_id', true)
    )
  );
