-- P50 — platform-owner SELECT for the Zoom Operations Center.
--
-- CONTINUES P46 EXACTLY, and deliberately adds nothing else. P46 gave the
-- platform owner read access to `live_sessions`,
-- `academy_live_provider_connections` and `live_session_participants` so
-- the webhook worker could resolve a tenant before entering it. The Zoom
-- operations pages need the same read for four more tables, and the same
-- reasoning applies unchanged.
--
-- SELECT ONLY, AND ONLY FOR A REAL PLATFORM OWNER. No write path, no
-- tenant-level widening: an ordinary member's context does not satisfy
-- `is_platform_owner`, so tenant isolation for every normal request is
-- completely unchanged. These policies sit ALONGSIDE the existing
-- `_tenant_select` policies rather than replacing them.
--
-- WHY THESE FOUR AND NOT MORE. Each one backs a page that cannot be built
-- without it, and nothing was added speculatively:
--
--   tenant_add_ons                    -> "Not Installed" is a real state on
--                                        the Connections page, and it is the
--                                        absence of an enabled add-on.
--   live_session_recordings           -> recording lifecycle + quota page.
--   live_session_recording_files      -> per-recording file counts.
--   live_session_attendance_intervals -> attendance reconciliation health.
--
-- `live_provider_events`, `users` and `add_ons` are NOT here: they carry no
-- row-level security at all, so a platform-owner context already reads them
-- and a policy would be meaningless.
--
-- Idempotent so a re-run is harmless.

DROP POLICY IF EXISTS "tenant_add_ons_platform_select" ON "tenant_add_ons";
CREATE POLICY "tenant_add_ons_platform_select" ON "tenant_add_ons"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

DROP POLICY IF EXISTS "live_session_recordings_platform_select" ON "live_session_recordings";
CREATE POLICY "live_session_recordings_platform_select" ON "live_session_recordings"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

DROP POLICY IF EXISTS "live_session_recording_files_platform_select" ON "live_session_recording_files";
CREATE POLICY "live_session_recording_files_platform_select" ON "live_session_recording_files"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

DROP POLICY IF EXISTS "live_session_attendance_intervals_platform_select" ON "live_session_attendance_intervals";
CREATE POLICY "live_session_attendance_intervals_platform_select" ON "live_session_attendance_intervals"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));
