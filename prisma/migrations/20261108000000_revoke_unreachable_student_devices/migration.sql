-- Device Identity + Device-Limit fix — retire device rows no browser can
-- ever present.
--
-- Before this release the lesson-grant endpoint registered a device for a
-- browser that carried no recognised `atlas_device` cookie, but had no way
-- to send the new cookie back. Each such row was unreachable from the
-- moment it was written: its cookie value existed only as a hash in this
-- table. Those rows still counted against the academy's device limit (the
-- "terminate does nothing" loop) and each announced "New device added".
--
-- An unreachable row is identified by facts, not guessed from labels:
--   * it is still active;
--   * no session was ever bound to it — every device sign-in registers
--     is referenced by that sign-in's refresh token, and refresh tokens
--     are never deleted;
--   * it was never seen again after the instant it was created — a
--     device whose cookie a browser holds is touched (`last_seen_at`) on
--     every later sign-in and grant.
-- Matching rows are REVOKED, not deleted: the learner's device history and
-- the access log that references them stay intact. Re-running this is a
-- no-op (only active rows match).
UPDATE "student_devices" AS d
SET "revoked_at" = now()
WHERE d."revoked_at" IS NULL
  AND d."last_seen_at" <= d."created_at" + interval '5 seconds'
  AND NOT EXISTS (
    SELECT 1 FROM "refresh_tokens" AS r WHERE r."device_id" = d."id"
  );
