-- ============================================================================
-- Phase P13 — a third, final RLS fix in the same discovered chain as
-- p13_1/p13_2: `EnrollmentsService.createEnrollmentInTransaction` (P6),
-- reused verbatim by `CourseOrderPaymentApplicationService.
-- applySuccessfulPayment` under the reviewing Platform Owner's own user
-- context (see p13_1's migration header), also materializes
-- `course_progress` (one row) and `lesson_progress` (one row per
-- published lesson) for the new Enrollment — both transitively
-- student-scoped only (P6), with no Platform-Owner path. Additive,
-- narrow, same `is_platform_owner()` predicate as p13_1/p13_2 — never a
-- blanket bypass. No UPDATE policy added for either table here — this
-- flow only ever INSERTs progress rows (a fresh Enrollment), never
-- updates them; lesson/course progress updates remain the student's own
-- exclusive path (`CourseProgressService.completeLesson`), unchanged.
-- ============================================================================

CREATE POLICY "course_progress_platform_insert" ON "course_progress"
  FOR INSERT
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "lesson_progress_platform_insert" ON "lesson_progress"
  FOR INSERT
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));
