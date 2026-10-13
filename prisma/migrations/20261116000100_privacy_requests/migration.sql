-- B0-SEC-13 — request-based data deletion and data export (CF-11, DL-20 (b)).
--
-- A person files a request from their profile, confirmed by an emailed code;
-- a Platform Owner handles it. Additive only: a new table, two enums, and a
-- `purpose` column on the existing emailed-code table (default keeps every
-- existing row and code path an account-deletion code).

ALTER TABLE "account_deletion_challenges"
  ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'account_deletion';
ALTER TABLE "account_deletion_challenges"
  ADD CONSTRAINT "account_deletion_challenges_purpose_check"
  CHECK ("purpose" IN ('account_deletion', 'privacy_request'));

CREATE TYPE "privacy_request_type" AS ENUM ('deletion', 'export');
CREATE TYPE "privacy_request_status" AS ENUM ('submitted', 'in_progress', 'completed', 'rejected');

CREATE TABLE "privacy_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "academy_id" TEXT,
    "type" "privacy_request_type" NOT NULL,
    "status" "privacy_request_status" NOT NULL DEFAULT 'submitted',
    "requester_email" TEXT NOT NULL,
    "requester_name" TEXT NOT NULL,
    "resolution_note" TEXT,
    "handled_by_user_id" TEXT,
    "export_available_until" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "privacy_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "privacy_requests_user_id_created_at_idx"
  ON "privacy_requests"("user_id", "created_at" DESC);
CREATE INDEX "privacy_requests_status_created_at_idx"
  ON "privacy_requests"("status", "created_at" DESC);

-- At most one OPEN request of each type per person: a second click, a retry
-- or a second tab returns the open one instead of queueing duplicates.
CREATE UNIQUE INDEX "privacy_requests_one_open_per_type"
  ON "privacy_requests"("user_id", "type")
  WHERE "status" IN ('submitted', 'in_progress');

ALTER TABLE "privacy_requests"
  ADD CONSTRAINT "privacy_requests_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "privacy_requests"
  ADD CONSTRAINT "privacy_requests_academy_id_fkey"
  FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "privacy_requests"
  ADD CONSTRAINT "privacy_requests_note_length_check"
    CHECK ("resolution_note" IS NULL OR char_length("resolution_note") <= 2000),
  ADD CONSTRAINT "privacy_requests_export_window_check"
    CHECK ("export_available_until" IS NULL OR "type" = 'export');

-- Who can see a request: the person who filed it, and Platform Owners. No
-- organization or academy policy exists, so no academy staff can read one —
-- a learner's privacy request is not the academy's business record.
ALTER TABLE "privacy_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "privacy_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY "privacy_requests_self_select" ON "privacy_requests"
  FOR SELECT USING ("user_id" = current_setting('app.current_user_id', true));
-- The requester may only create a fresh, unhandled request for themselves.
CREATE POLICY "privacy_requests_self_insert" ON "privacy_requests"
  FOR INSERT WITH CHECK (
    "user_id" = current_setting('app.current_user_id', true)
    AND "status" = 'submitted'
    AND "handled_by_user_id" IS NULL
    AND "resolution_note" IS NULL
    AND "export_available_until" IS NULL
    AND "completed_at" IS NULL
  );
CREATE POLICY "privacy_requests_platform_select" ON "privacy_requests"
  FOR SELECT USING (is_platform_owner(current_setting('app.current_user_id', true)));
CREATE POLICY "privacy_requests_platform_update" ON "privacy_requests"
  FOR UPDATE USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));
