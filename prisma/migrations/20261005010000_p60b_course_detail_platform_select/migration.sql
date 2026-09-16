-- P60b — let the Platform Owner read the parts of a course they can already
-- read the course itself.
--
-- P15 gave `courses` a `courses_platform_select` policy, but stopped there.
-- The consequence only became visible when a real course DETAIL page was
-- built: the Platform Owner could see that a course exists, and nothing
-- inside it. `course_sections`/`course_lessons`/`course_instructors`/
-- `course_categories` grant SELECT only to the course's own tenant, its
-- enrolled students, its instructors, or the public-discovery predicate
-- (`published` + `public`) — so a DRAFT course's curriculum and teaching
-- staff were invisible to the one role whose entire job is oversight.
--
-- These four policies are the same shape as P15's, deliberately:
--   * PERMISSIVE and additive. Postgres OR's multiple permissive policies
--     for one command, so every existing tenant/enrolled/instructor policy
--     is byte-for-byte untouched. No tenant user gains or loses a row.
--   * SELECT only. No platform INSERT/UPDATE/DELETE — the platform course
--     surface is read-only by design, and RLS says so independently of the
--     fact that no write endpoint exists.
--   * The EXISTING `is_platform_owner(text)` SECURITY DEFINER function from
--     P12, verbatim. No new predicate, no second definition of "is this an
--     owner".
-- Reads happen under `runInUserContext(platformOwnerId)` with no
-- `app.current_organization_id` set, so the tenant policies cannot match
-- and only this one makes a cross-tenant row visible.

CREATE POLICY "course_sections_platform_select" ON "course_sections"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "course_lessons_platform_select" ON "course_lessons"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "course_instructors_platform_select" ON "course_instructors"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "course_categories_platform_select" ON "course_categories"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));
