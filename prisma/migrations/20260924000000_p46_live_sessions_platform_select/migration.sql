-- Phase 12 (part 4) — let system-initiated reads attribute a provider
-- event to its tenant.
--
-- THE PROBLEM THIS SOLVES, found by an integration test rather than by
-- reasoning. An inbound Zoom webhook has NO tenant context — it is
-- authenticated by signature, not by session — but to verify that
-- signature Atlas must first discover WHICH academy's secret to check it
-- against, which means reading `live_sessions` by `provider_meeting_id`.
-- Under `FORCE ROW LEVEL SECURITY` with no `app.current_organization_id`
-- set, that read correctly returned nothing, so every genuinely signed
-- webhook was refused as unattributable.
--
-- RLS was not wrong; the query had no business running without a context.
-- The fix is to give it one, using the mechanism Atlas already has for
-- exactly this class of cross-tenant system read: the Platform Owner
-- context (`is_platform_owner`), the same one
-- `tenant_subscriptions_platform_select` gives the subscription sweep and
-- `course_orders_platform_select` gives the platform control plane.
--
-- SELECT ONLY, AND ONLY FOR A REAL PLATFORM OWNER. This grants no write
-- path and no tenant-level widening: an ordinary member's context does not
-- satisfy `is_platform_owner`, so tenant isolation for every normal
-- request is completely unchanged. The webhook worker resolves the tenant
-- through this, then does all subsequent work inside that tenant's own
-- context, exactly as before.

CREATE POLICY "live_sessions_platform_select" ON "live_sessions"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "academy_live_provider_connections_platform_select"
  ON "academy_live_provider_connections"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "live_session_participants_platform_select"
  ON "live_session_participants"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));
