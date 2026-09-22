-- P64 Phase 3 (S12) — protected assignment attachments.
--
-- An attachment must be "a protected asset uploaded by the student". The
-- media_assets table never recorded who uploaded an object, so ownership
-- could only be inferred from a key prefix. This adds the fact as a
-- column and lets the uploader read their own protected asset under their
-- user context (the learner's own submission view, and the ownership
-- check at submit time). Additive; NULL for every existing row.

ALTER TABLE "media_assets" ADD COLUMN "uploaded_by_user_id" TEXT;
CREATE INDEX "media_assets_uploaded_by_user_id_idx" ON "media_assets"("uploaded_by_user_id");

CREATE POLICY "media_assets_uploader_select" ON "media_assets"
  FOR SELECT
  USING ("uploaded_by_user_id" = current_setting('app.current_user_id', true));
