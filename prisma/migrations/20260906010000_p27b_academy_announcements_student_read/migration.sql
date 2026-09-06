-- ============================================================================
-- P27b — fixes a real gap found while testing P27's new academy-wide
-- announcement authoring: `announcements_academy_member_select` (P7
-- migration) reads `is_academy_member`, which only checks the STAFF
-- `academy_members` table — a real Student (who only ever holds an
-- `academy_students` row, never an `academy_members` one; see the P21
-- migration's own doc comment) could never see a published academy-wide
-- announcement at all, even though "academy-wide" is meant to reach the
-- whole Academy, students included. Confirmed live: an e2e test enrolling
-- a real student, publishing a real academy-wide announcement, and
-- checking that student's own `GET /announcements` feed returned an empty
-- array before this fix.
--
-- Additive only — mirrors `announcements_academy_member_select` exactly,
-- reusing the ALREADY-EXISTING `is_academy_student` function (P21
-- migration) rather than adding a new one; never replaces or narrows the
-- existing staff-read policy, per this codebase's own "same-command
-- policies are OR'd together" RLS discipline.
-- ============================================================================

CREATE POLICY "announcements_academy_student_select" ON "announcements"
  FOR SELECT
  USING (
    "announcements"."status" = 'published'
    AND "announcements"."academy_id" IS NOT NULL
    AND is_academy_student("announcements"."academy_id", current_setting('app.current_user_id', true))
  );
