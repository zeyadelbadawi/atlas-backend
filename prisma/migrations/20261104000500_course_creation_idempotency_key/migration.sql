-- W6 — idempotent course creation.
--
-- `POST /academies/:id/courses` accepts an optional client key
-- (`CreateCourseDto.idempotencyKey`). The course a create made records the
-- key it was sent with; a repeat create with the same key in the same
-- academy returns that course instead of making a second draft (or failing
-- with a misleading `slugTaken` on the course it already made).
--
-- ADDITIVE ONLY. One nullable column and one unique index. Existing rows
-- keep NULL, and a Postgres unique index admits any number of NULLs, so no
-- existing course can conflict and no data is rewritten. RLS is unchanged:
-- the column lives on `courses`, whose FORCE RLS policies and `atlas_app`
-- table grants already cover every column.
--
-- Reversal (safe at any time; the column carries no data anything else
-- depends on):
--   DROP INDEX IF EXISTS "courses_academy_id_creation_idempotency_key_key";
--   ALTER TABLE "courses" DROP COLUMN IF EXISTS "creation_idempotency_key";
ALTER TABLE "courses"
  ADD COLUMN IF NOT EXISTS "creation_idempotency_key" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "courses_academy_id_creation_idempotency_key_key"
  ON "courses" ("academy_id", "creation_idempotency_key");
