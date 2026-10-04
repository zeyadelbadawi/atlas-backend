-- ============================================================================
-- Security review, finding 5 — the RLS membership helpers count only ACTIVE
-- academy staff.
--
-- `is_academy_member(text, text)` (P7, 20260825083701) and
-- `can_author_course_content(text, text)` (P24, 20260904000000) matched any
-- `academy_members` row, so an `inactive` or `pending` staff row kept the
-- database-level reach those helpers grant (community participation, quiz /
-- assignment authoring for owner/administrator/manager) after the member was
-- deactivated. The application-level checks they mirror now filter on
-- `status = 'active'` too (AcademyMembersRepository.findForUserInAcademy).
--
-- Redefined with CREATE OR REPLACE: the signature, LANGUAGE sql, STABLE,
-- SECURITY DEFINER and `search_path = public` are identical to the current
-- definitions, and CREATE OR REPLACE keeps the owner and EXECUTE grants, so
-- every policy that calls them is untouched. The only change is the
-- `"status" = 'active'` predicate on `academy_members`. The course-instructor
-- branch of `can_author_course_content` is unchanged (an assigned instructor,
-- exactly as `assertCanAuthorCourseContent`'s `isInstructor`).
--
-- Reversal: re-run the two CREATE OR REPLACE statements from P7 / P24
-- without the status predicate.
-- ============================================================================

CREATE OR REPLACE FUNCTION is_academy_member(p_academy_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "academy_members"
    WHERE "academy_id" = p_academy_id
      AND "user_id" = p_user_id
      AND "status" = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION can_author_course_content(p_course_id text, p_user_id text)
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
        AND am."status" = 'active'
        AND am."role" IN ('owner', 'administrator', 'manager')
    );
$$;
