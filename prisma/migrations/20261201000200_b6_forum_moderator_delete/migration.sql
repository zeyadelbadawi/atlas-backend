-- B6 (UX audit) V05 — a course moderator can delete a forum thread or reply.
--
-- Until now a blank, wrong or abusive post could not be removed by anyone:
-- `forum_threads` had only SELECT/INSERT/UPDATE policies and `forum_replies`
-- only SELECT/INSERT, both under FORCE ROW LEVEL SECURITY. These add DELETE
-- for the same people who may already pin and lock (`is_course_moderator`,
-- the function `forum_threads_moderate_update` uses). Deleting a thread
-- removes its replies through the existing ON DELETE CASCADE.
--
-- Policies only: no table, column or data change.

CREATE POLICY "forum_threads_moderate_delete" ON "forum_threads"
  FOR DELETE
  USING (is_course_moderator("forum_threads"."course_id", current_setting('app.current_user_id', true)));

CREATE POLICY "forum_replies_moderate_delete" ON "forum_replies"
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM "forum_threads" t
      WHERE t."id" = "forum_replies"."thread_id"
        AND is_course_moderator(t."course_id", current_setting('app.current_user_id', true))
    )
  );
