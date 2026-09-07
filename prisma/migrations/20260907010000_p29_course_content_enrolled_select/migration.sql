-- ============================================================================
-- P29 — real gap found while wiring the Student-facing lesson-content
-- endpoint (Academy-website-embedded learning experience).
--
-- `course_sections`/`course_lessons` (P5 tables) only ever had
-- `*_tenant_select` (organization-context-only) and
-- `*_public_discovery_select` (added in the P6 migration, narrowly, so
-- `EnrollmentsService.createEnrollment` could count a PUBLISHED+PUBLIC
-- course's real lessons at enrollment time — see that migration's own
-- header comment). Neither covers the actual, common case this endpoint
-- serves: a real, actively enrolled student reading their own course's
-- curriculum under `app.current_user_id` alone, for a course that may be
-- `private`/unlisted visibility (invite-only enrollment is a normal,
-- supported enrollment path — `Enrollment` rows are never restricted to
-- public-visibility courses). Confirmed live: an enrolled student on a
-- non-public-visibility course got zero sections back from the new
-- endpoint despite `assertCourseReadAccess` correctly permitting the
-- request at the service layer — an RLS/service-layer authorization
-- mismatch, not a missing feature.
--
-- Mirrors `quizzes_enrolled_select`/`quiz_questions_enrolled_select`
-- (same P6 migration) exactly — same enrolled-student shape, same tables'
-- sibling relationship (course_sections/course_lessons are the curriculum
-- content a quiz's own course_id already grants read access to). Additive
-- only: OR'd alongside every existing SELECT policy on these two tables,
-- never replacing or narrowing any of them.
-- ============================================================================

CREATE POLICY "course_sections_enrolled_select" ON "course_sections"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      WHERE e."course_id" = "course_sections"."course_id"
        AND e."student_id"::text = current_setting('app.current_user_id', true)
        AND e."status" IN ('enrolled', 'completed')
    )
  );

CREATE POLICY "course_lessons_enrolled_select" ON "course_lessons"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      WHERE e."course_id" = "course_lessons"."course_id"
        AND e."student_id"::text = current_setting('app.current_user_id', true)
        AND e."status" IN ('enrolled', 'completed')
    )
  );
