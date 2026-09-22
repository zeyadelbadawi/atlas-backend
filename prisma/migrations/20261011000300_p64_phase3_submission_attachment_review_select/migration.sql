-- P64 Phase 3 (S12) — reviewers may READ the protected attachment a student
-- submitted, so the grading view can sign a short-lived link to it. Scoped
-- through the submission → assignment → course chain and the Phase 1
-- `can_review_course` tier (course instructor, academy owner /
-- administrator / manager). Additive SELECT only; no other asset becomes
-- visible.
CREATE POLICY "media_assets_submission_review_select" ON "media_assets"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM "assignment_submissions" s
      JOIN "assignments" a ON a."id" = s."assignment_id"
      WHERE s."attachment_asset_id" = "media_assets"."id"
        AND can_review_course(a."course_id", current_setting('app.current_user_id', true))
    )
  );
