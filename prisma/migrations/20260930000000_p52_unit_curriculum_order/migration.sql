-- P52 — Unified ordered curriculum inside course units.
--
-- Adds a shared per-unit ordinal so a Unit (course_sections) can compose
-- its existing lessons, quizzes, assignments and (future) live sessions
-- into ONE ordered sequence. No polymorphic table is introduced: each
-- content type keeps its own table and identity; `order` is simply a
-- single integer space per section that every type participates in.
--
-- course_lessons.order and live_sessions.order already exist. This adds the
-- same column to quizzes and assignments.

ALTER TABLE "quizzes" ADD COLUMN IF NOT EXISTS "order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "order" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "quizzes_section_id_order_idx" ON "quizzes" ("section_id", "order");
CREATE INDEX IF NOT EXISTS "assignments_section_id_order_idx" ON "assignments" ("section_id", "order");

-- SetNull on unit delete (quiz/assignment survives as a course-level item).
-- Named to match Prisma's generated FK constraint name so the client stays
-- in sync. Guarded so re-running is harmless.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quizzes_section_id_fkey'
  ) THEN
    ALTER TABLE "quizzes"
      ADD CONSTRAINT "quizzes_section_id_fkey"
      FOREIGN KEY ("section_id") REFERENCES "course_sections"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assignments_section_id_fkey'
  ) THEN
    ALTER TABLE "assignments"
      ADD CONSTRAINT "assignments_section_id_fkey"
      FOREIGN KEY ("section_id") REFERENCES "course_sections"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Deterministic, lossless backfill of the shared ordinal for content that
-- is ALREADY placed in a unit. Within each section the existing lessons keep
-- their relative order first (offset by 0), then live sessions, then quizzes,
-- then assignments are appended after them — so nothing that was ordered
-- loses its relative order, and cross-type items get a stable initial
-- sequence an author can then rearrange. Course-level quizzes/assignments
-- (section_id IS NULL) are untouched: they are simply not in any unit yet.

-- Quizzes: append after the max (lesson/live-session) order in their section.
WITH base AS (
  SELECT s.id AS section_id,
         GREATEST(
           COALESCE((SELECT MAX(l."order") FROM course_lessons l WHERE l.section_id = s.id), -1),
           COALESCE((SELECT MAX(ls."order") FROM live_sessions ls WHERE ls.section_id = s.id), -1)
         ) AS max_before
  FROM course_sections s
),
ranked AS (
  SELECT q.id,
         b.max_before + ROW_NUMBER() OVER (
           PARTITION BY q.section_id ORDER BY q.created_at, q.id
         ) AS new_order
  FROM quizzes q
  JOIN base b ON b.section_id = q.section_id
  WHERE q.section_id IS NOT NULL
)
UPDATE quizzes q SET "order" = r.new_order
FROM ranked r WHERE r.id = q.id;

-- Assignments: append after lessons + live sessions + quizzes in their section.
WITH base AS (
  SELECT s.id AS section_id,
         GREATEST(
           COALESCE((SELECT MAX(l."order") FROM course_lessons l WHERE l.section_id = s.id), -1),
           COALESCE((SELECT MAX(ls."order") FROM live_sessions ls WHERE ls.section_id = s.id), -1),
           COALESCE((SELECT MAX(q."order") FROM quizzes q WHERE q.section_id = s.id), -1)
         ) AS max_before
  FROM course_sections s
),
ranked AS (
  SELECT a.id,
         b.max_before + ROW_NUMBER() OVER (
           PARTITION BY a.section_id ORDER BY a.created_at, a.id
         ) AS new_order
  FROM assignments a
  JOIN base b ON b.section_id = a.section_id
  WHERE a.section_id IS NOT NULL
)
UPDATE assignments a SET "order" = r.new_order
FROM ranked r WHERE r.id = a.id;
