-- LMS UX pass — real bug found live during Announcements-tab browser
-- testing: an Academy `manager` creating a course-scoped announcement
-- (a real, intentional permission — every `MANAGING_ROLES` constant in
-- this codebase, `AnnouncementsService.assertCanManage` included, is
-- `{'owner', 'administrator', 'manager'}`, and that app-layer check
-- correctly PASSED) got a raw 500, not a success: `is_course_moderator()`
-- (P7, the SQL function backing every `announcements_manage_*`/
-- `forum_threads`/`forum_thread_moderate_*` RLS policy) only ever checked
-- `role IN ('owner', 'administrator')` — 'manager' was never added here,
-- even though it was added to every app-level `MANAGING_ROLES` set. One
-- isolated, out-of-sync SQL function, not a new authorization decision —
-- `CREATE OR REPLACE FUNCTION` so every policy already built on top of it
-- (announcements insert/update/manage-select, forum thread moderation)
-- picks up the fix with no migration to any of those policies themselves.
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
    );
$$;
