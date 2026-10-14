-- =============================================================================
-- B0-LIV-03 — FORCE RLS on `live_provider_events`.
--
-- The Zoom webhook event log was the one live-sessions table without
-- row-level security. It holds provider account ids and meeting metadata,
-- and nothing but the platform should read it. Same discipline as the
-- communications tables (P64 C0):
--
--   * INSERT is open (`WITH CHECK (true)`): a webhook arrives with no
--     tenant and no user — it is authenticated by signature — so the row
--     must be writable before anyone is known.
--   * SELECT and UPDATE are the Platform Owner's only, through
--     `is_platform_owner(app.current_user_id)`. The webhook processor marks
--     events under the platform-owner user context (the sweep precedent),
--     and the Zoom operations page already reads under it.
--   * No DELETE policy: nothing deletes these rows today.
--
-- A tenant session, a learner session and a context-less session read zero
-- rows. Idempotent, so a re-run is harmless.
--
-- Rollback: `ALTER TABLE "live_provider_events" NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "live_provider_events" DISABLE ROW LEVEL SECURITY;` (the
-- policies are then inert). The new repository works with RLS on or off.
-- Deploy window: between this migration and the new backend, the OLD
-- backend's context-less status updates match zero rows, so events
-- received in that window stay `received` (recorded, never lost).
-- =============================================================================

ALTER TABLE "live_provider_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "live_provider_events" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "live_provider_events_system_insert" ON "live_provider_events";
CREATE POLICY "live_provider_events_system_insert" ON "live_provider_events"
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "live_provider_events_platform_select" ON "live_provider_events";
CREATE POLICY "live_provider_events_platform_select" ON "live_provider_events"
  FOR SELECT USING (is_platform_owner(current_setting('app.current_user_id', true)));

DROP POLICY IF EXISTS "live_provider_events_platform_update" ON "live_provider_events";
CREATE POLICY "live_provider_events_platform_update" ON "live_provider_events"
  FOR UPDATE USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));
