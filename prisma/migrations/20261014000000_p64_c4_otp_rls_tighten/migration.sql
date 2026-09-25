-- P64 Communications C4 — restore the two-gate rule on the OTP tables.
--
-- THE DEFECT. The foundation migration gave `auth_email_challenges` and
-- `trusted_devices` permissive `USING (true)` SELECT and UPDATE policies
-- alongside their self-scoped ones. PostgreSQL OR-combines permissive
-- policies, so `USING (true)` does not sit beside `user_id = current_user`
-- — it REPLACES it. On these two tables RLS therefore imposed no
-- cross-user constraint at all, and the only thing keeping one account's
-- login codes and trusted devices away from another was the `user_id`
-- predicate in the service layer.
--
-- That is precisely the arrangement Atlas's two-gate rule exists to
-- forbid: the service guard and RLS are supposed to agree INDEPENDENTLY,
-- so that a single missed predicate in a future query is contained rather
-- than catastrophic. These are authentication factors; they are the last
-- tables that should rely on one gate.
--
-- WHY THE PERMISSIVE POLICIES WERE THERE, AND WHY THEY ARE NOT NEEDED.
-- The OTP verify request carries no session, so the original schema
-- assumed a challenge must be readable before its owner is known. The
-- implementation does not work that way: the challenge reference handed
-- to the client is AES-256-GCM sealed over `<rowId>.<userId>`, so the
-- service recovers the owner IN MEMORY from the reference and then opens
-- every statement inside `runInUserContext(userId)`. There is no path
-- that touches either table without a user context.
--
-- SAFETY. No deployed code reads or writes these tables — the C4 feature
-- ships in the same release as this migration — so narrowing the policies
-- cannot break a running version, and both tables are empty in production.

-- ---- auth_email_challenges -------------------------------------------------
DROP POLICY IF EXISTS "auth_email_challenges_system_select" ON "auth_email_challenges";
DROP POLICY IF EXISTS "auth_email_challenges_system_update" ON "auth_email_challenges";
DROP POLICY IF EXISTS "auth_email_challenges_system_insert" ON "auth_email_challenges";

-- A challenge is inserted for the user the session context names, so the
-- INSERT can no longer mint a row that belongs to somebody else.
CREATE POLICY "auth_email_challenges_self_insert" ON "auth_email_challenges"
  FOR INSERT WITH CHECK ("user_id"::text = current_setting('app.current_user_id', true));
CREATE POLICY "auth_email_challenges_self_select" ON "auth_email_challenges"
  FOR SELECT USING ("user_id"::text = current_setting('app.current_user_id', true));
-- `WITH CHECK` repeats the predicate so an UPDATE cannot reassign a
-- challenge to another user on its way out.
CREATE POLICY "auth_email_challenges_self_update" ON "auth_email_challenges"
  FOR UPDATE USING ("user_id"::text = current_setting('app.current_user_id', true))
  WITH CHECK ("user_id"::text = current_setting('app.current_user_id', true));

-- Deliberately NO platform-owner SELECT. A live login code is not
-- something the Platform Owner has any reason to read, and the C7 console
-- reports counts, never codes.

-- ---- trusted_devices -------------------------------------------------------
-- `self_select`, `self_update` and `platform_select` already exist and are
-- correct; only the three permissive ones are removed. Platform-owner
-- SELECT is kept here (and not above) because a support case legitimately
-- asks "which devices does this account trust?" — a device list is
-- metadata, not a credential.
DROP POLICY IF EXISTS "trusted_devices_system_select" ON "trusted_devices";
DROP POLICY IF EXISTS "trusted_devices_system_update" ON "trusted_devices";
DROP POLICY IF EXISTS "trusted_devices_system_insert" ON "trusted_devices";

CREATE POLICY "trusted_devices_self_insert" ON "trusted_devices"
  FOR INSERT WITH CHECK ("user_id"::text = current_setting('app.current_user_id', true));
