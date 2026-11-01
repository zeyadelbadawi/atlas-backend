-- Atlas mobile app — learner sync: notes, due-date pushes.
--
-- 1. `push_devices.due_reminders` — the learner turned on "push me the day
--    before a quiz or assignment is due" for this device. Defaults to off,
--    so every existing device behaves exactly as before.
--
-- 2. `learner_notes` — a learner's own note and "saved" mark on a lesson,
--    so they follow the learner to another phone. Own-row FORCE RLS on
--    every command: nobody else, staff included, reads them.
--
-- 3. `due_reminder_sends` — one row per due-date push sent. The sweep
--    inserts it (ON CONFLICT DO NOTHING) before sending, in the learner's
--    own context, so two sweeps never push the same reminder twice.
--
-- 4. `due_reminder_candidates()` — the sweep's cross-academy pick: which
--    learners with the reminder on have a published quiz or assignment due
--    soon in a course they are enrolled in, not yet reminded. SECURITY
--    DEFINER like `release_push_token`, so no table's visibility widens:
--    it answers only under platform-owner context, returns ids and the due
--    date only (never a token), and every write stays own-row RLS.
--
-- PURELY ADDITIVE. New column with a default, new tables, one new
-- function. Nothing the web reads changes; the due-date push never creates a
-- notification row, so the web inbox is untouched.

ALTER TABLE "push_devices" ADD COLUMN "due_reminders" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "learner_notes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "lesson_id" TEXT NOT NULL,
    "note" VARCHAR(4000) NOT NULL DEFAULT '',
    "saved" BOOLEAN NOT NULL DEFAULT false,
    "edited_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learner_notes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "learner_notes_user_lesson_key" ON "learner_notes"("user_id", "lesson_id");
CREATE INDEX "learner_notes_user_academy_idx" ON "learner_notes"("user_id", "academy_id");

ALTER TABLE "learner_notes"
  ADD CONSTRAINT "learner_notes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "learner_notes"
  ADD CONSTRAINT "learner_notes_academy_id_fkey"
  FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "learner_notes"
  ADD CONSTRAINT "learner_notes_lesson_id_fkey"
  FOREIGN KEY ("lesson_id") REFERENCES "course_lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "learner_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "learner_notes" FORCE ROW LEVEL SECURITY;

CREATE POLICY "learner_notes_self_select" ON "learner_notes"
  FOR SELECT USING ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "learner_notes_self_insert" ON "learner_notes"
  FOR INSERT WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "learner_notes_self_update" ON "learner_notes"
  FOR UPDATE USING ("user_id" = current_setting('app.current_user_id', true))
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "learner_notes_self_delete" ON "learner_notes"
  FOR DELETE USING ("user_id" = current_setting('app.current_user_id', true));

CREATE TABLE "due_reminder_sends" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "item_type" VARCHAR(16) NOT NULL,
    "item_id" TEXT NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "due_reminder_sends_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "due_reminder_sends_once_key"
  ON "due_reminder_sends"("user_id", "item_type", "item_id", "due_at");

ALTER TABLE "due_reminder_sends"
  ADD CONSTRAINT "due_reminder_sends_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "due_reminder_sends"
  ADD CONSTRAINT "due_reminder_sends_item_type_check" CHECK ("item_type" IN ('quiz', 'assignment'));

ALTER TABLE "due_reminder_sends" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "due_reminder_sends" FORCE ROW LEVEL SECURITY;

CREATE POLICY "due_reminder_sends_self_select" ON "due_reminder_sends"
  FOR SELECT USING ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "due_reminder_sends_self_insert" ON "due_reminder_sends"
  FOR INSERT WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
-- Released when every push for it failed transiently, so the next tick retries.
CREATE POLICY "due_reminder_sends_self_delete" ON "due_reminder_sends"
  FOR DELETE USING ("user_id" = current_setting('app.current_user_id', true));
CREATE FUNCTION due_reminder_candidates(p_now TIMESTAMP(3), p_until TIMESTAMP(3), p_limit INTEGER)
RETURNS TABLE (
  user_id TEXT,
  academy_id TEXT,
  academy_name TEXT,
  kind TEXT,
  item_id TEXT,
  course_id TEXT,
  due_at TIMESTAMP(3)
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_platform_owner(current_setting('app.current_user_id', true)) THEN
    RETURN;
  END IF;
  RETURN QUERY
    WITH items AS (
      SELECT 'quiz'::text AS kind, q.id, q.course_id, q.due_at
        FROM "quizzes" q
       WHERE q.status = 'published' AND q.due_at > p_now AND q.due_at <= p_until
      UNION ALL
      SELECT 'assignment'::text, a.id, a.course_id, a.due_at
        FROM "assignments" a
       WHERE a.status = 'published' AND a.due_at > p_now AND a.due_at <= p_until
    ),
    learners AS (
      SELECT DISTINCT d.user_id, d.academy_id
        FROM "push_devices" d
       WHERE d.due_reminders
    )
    SELECT l.user_id, l.academy_id, ac.name::text, i.kind, i.id, i.course_id, i.due_at
      FROM items i
      JOIN "courses" c ON c.id = i.course_id AND c.status = 'published'
      JOIN "enrollments" e ON e.course_id = i.course_id
                          AND e.status IN ('enrolled', 'completed')
                          AND e.revoked_at IS NULL
                          AND (e.expires_at IS NULL OR e.expires_at > p_now)
      JOIN learners l ON l.user_id = e.student_id AND l.academy_id = e.academy_id
      JOIN "academies" ac ON ac.id = l.academy_id
     WHERE NOT EXISTS (
             SELECT 1 FROM "due_reminder_sends" s
              WHERE s.user_id = l.user_id AND s.item_type = i.kind
                AND s.item_id = i.id AND s.due_at = i.due_at)
     ORDER BY i.due_at ASC
     LIMIT GREATEST(LEAST(p_limit, 1000), 0);
END
$$;

REVOKE ALL ON FUNCTION due_reminder_candidates(TIMESTAMP(3), TIMESTAMP(3), INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION due_reminder_candidates(TIMESTAMP(3), TIMESTAMP(3), INTEGER) TO "atlas_app";
