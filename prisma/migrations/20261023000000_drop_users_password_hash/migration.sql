-- Production-readiness pass, stage 2 of the credential split
-- (20261022000000_user_credentials was stage 1).
--
-- Stage 1 moved every password hash into `user_credentials` (self-only RLS)
-- and kept `users.password_hash` as an always-NULL column with capture
-- triggers, so the PREVIOUS backend — still serving while stage 1 migrated —
-- kept working. That backend is gone; nothing reads or writes the column.
-- Remove it and its triggers.
--
-- Fail closed: if any non-NULL value survived (it cannot, the triggers
-- capture every write), stop rather than drop a credential.
DO $$
DECLARE
  leftover bigint;
BEGIN
  SELECT count(*) INTO leftover FROM "users" WHERE "password_hash" IS NOT NULL;
  IF leftover > 0 THEN
    RAISE EXCEPTION 'users.password_hash still holds % value(s); refusing to drop', leftover;
  END IF;
END $$;

DROP TRIGGER IF EXISTS "users_capture_legacy_password_hash_update" ON "users";
DROP TRIGGER IF EXISTS "users_capture_legacy_password_hash_insert" ON "users";
DROP FUNCTION IF EXISTS users_capture_legacy_password_hash();
DROP FUNCTION IF EXISTS users_capture_legacy_password_hash_insert();

ALTER TABLE "users" DROP COLUMN "password_hash";
