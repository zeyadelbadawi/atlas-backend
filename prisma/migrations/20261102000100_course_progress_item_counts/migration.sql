-- Course progress across the whole sequence, not lessons alone (2 Oct 2026).
--
-- `course_progress.percentage` already counts lessons, quizzes and
-- assignments (P4), but the counts beside it were lessons only, so a
-- quiz-only course read "0 of 0 lessons completed" next to a real
-- percentage. These two columns carry the counts the percentage is computed
-- from; `CourseCompletionService.recompute` writes all three together.
--
-- Additive: two columns with a default, and a backfill that applies the
-- same definition as `computeItemProgress` to every existing row. No row is
-- deleted.

ALTER TABLE "course_progress"
  ADD COLUMN "total_items" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "completed_items" INTEGER NOT NULL DEFAULT 0;

WITH counts AS (
  SELECT
    e."id" AS enrollment_id,
    (SELECT count(*) FROM "lesson_progress" lp
       WHERE lp."enrollment_id" = e."id") AS lessons_total,
    (SELECT count(*) FROM "lesson_progress" lp
       WHERE lp."enrollment_id" = e."id" AND lp."status" = 'completed') AS lessons_done,
    (SELECT count(*) FROM "quizzes" q
       WHERE q."course_id" = e."course_id" AND q."status" = 'published') AS quizzes_total,
    (SELECT count(*) FROM "quizzes" q
       WHERE q."course_id" = e."course_id" AND q."status" = 'published'
         AND EXISTS (
           SELECT 1 FROM "quiz_results" r
           WHERE r."quiz_id" = q."id" AND r."student_id" = e."student_id"
             AND (r."passed" OR r."pending_grading"))) AS quizzes_done,
    (SELECT count(*) FROM "assignments" a
       WHERE a."course_id" = e."course_id" AND a."status" = 'published') AS assignments_total,
    (SELECT count(*) FROM "assignments" a
       WHERE a."course_id" = e."course_id" AND a."status" = 'published'
         AND EXISTS (
           SELECT 1 FROM "assignment_submissions" s
           WHERE s."assignment_id" = a."id" AND s."student_id" = e."student_id"
             AND (s."status" = 'submitted' OR s."grading_status" = 'graded'))) AS assignments_done
  FROM "enrollments" e
)
UPDATE "course_progress" cp
SET "total_items" = c.lessons_total + c.quizzes_total + c.assignments_total,
    "completed_items" = c.lessons_done + c.quizzes_done + c.assignments_done,
    "percentage" = CASE
      WHEN c.lessons_total + c.quizzes_total + c.assignments_total > 0
        THEN round(
          (c.lessons_done + c.quizzes_done + c.assignments_done)::numeric * 100
          / (c.lessons_total + c.quizzes_total + c.assignments_total), 2)
      ELSE 0
    END
FROM counts c
WHERE cp."enrollment_id" = c.enrollment_id;
