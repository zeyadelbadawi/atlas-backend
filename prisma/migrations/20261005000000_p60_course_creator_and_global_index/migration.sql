-- P60 — a real Course creator, and an index for the platform-wide list.
--
-- WHY A COLUMN AND NOT AUDIT-LOG RECONSTRUCTION. "Who created this course"
-- is a PROPERTY OF THE COURSE, not an event, so it belongs on the row. The
-- audit log can answer it today only because `course.created` happens to be
-- audited, and only for courses created after auditing existed — measured
-- on a real database, 6 of 108 courses (6%) have such an entry. Depending
-- on that permanently would mean a core field that silently works for some
-- rows and not others.
--
-- `SET NULL`, matching every other "who did this" relation in this schema
-- (`TrialRedemption.redeemedByUser`, `SubscriptionCancellation.
-- cancelledByUser`, `AssignmentSubmission.grader`, `WebsitePage.updatedBy`,
-- `LiveProviderConnection.connectedByUser`). Deleting a user must never
-- delete their academy's courses, and must never block the deletion either
-- — the course survives with an honestly-unknown creator.
ALTER TABLE "courses"
  ADD COLUMN IF NOT EXISTS "created_by_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'courses_created_by_id_fkey'
  ) THEN
    ALTER TABLE "courses"
      ADD CONSTRAINT "courses_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "courses_created_by_id_idx" ON "courses" ("created_by_id");

-- BACKFILL FROM PROVABLE EVIDENCE ONLY.
--
-- The single source of truth for a historical creator is a `course.created`
-- audit entry naming that exact course. Where one exists, its `actor_user_id`
-- IS the creator — recorded at the time by the service that performed the
-- creation. Where none exists, the column stays NULL and the UI reports
-- "not recorded" rather than guessing.
--
-- Deliberately NOT used as a fallback: the academy owner, the first
-- instructor, or the earliest academy member. Each would be a plausible
-- guess presented as a fact, which is worse than an honest blank.
--
-- `DISTINCT ON` because a course could in principle carry more than one
-- creation entry (a re-run, a fixture); the earliest is the real one.
UPDATE "courses" c
SET "created_by_id" = evidence.actor_user_id
FROM (
  SELECT DISTINCT ON (a."target_id")
         a."target_id" AS course_id,
         a."actor_user_id" AS actor_user_id
  FROM "audit_log_entries" a
  WHERE a."action" = 'course.created'
    AND a."target_type" = 'course'
  ORDER BY a."target_id", a."occurred_at" ASC
) AS evidence
WHERE c."id" = evidence.course_id
  AND c."created_by_id" IS NULL
  -- The actor must still exist; a deleted user cannot be referenced.
  AND EXISTS (SELECT 1 FROM "users" u WHERE u."id" = evidence.actor_user_id);

-- The platform-wide course list is ordered by recency across ALL academies.
-- The existing indexes are `(academy_id, status, visibility)` and
-- `(status, visibility)` — neither serves that sort, so the global list
-- would sequential-scan and sort. This is the index for it.
CREATE INDEX IF NOT EXISTS "courses_created_at_idx" ON "courses" ("created_at" DESC);
