-- P49b — Atlas-owned Zoom OAuth: token-set storage and single-use state.
--
-- CONTEXT THAT MAKES THIS SAFE. Production currently has ZERO connected
-- academies (`encrypted_credentials` is NULL everywhere), so there is no
-- customer authorization to preserve and no dual-mode period to support.
-- What changes is the CONTENT of the existing encrypted envelope — from a
-- customer's Zoom client secret to an OAuth token set — not the
-- encryption seam, which is unchanged.
--
-- Every column added here is NULLABLE or DEFAULTED, so this cannot abort
-- on a non-empty table (the P44 `tenant_add_ons` failure mode).

ALTER TABLE "academy_live_provider_connections"
  ADD COLUMN IF NOT EXISTS "access_token_expires_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "refresh_token_expires_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "granted_scopes" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "external_user_id" TEXT,
  ADD COLUMN IF NOT EXISTS "external_user_email" TEXT;

-- ONE ZOOM ACCOUNT, ONE ACADEMY — while the connection is live.
--
-- Webhooks are attributed by the VERIFIED `payload.account_id`. If two
-- academies bound the same Zoom account, that mapping would be ambiguous
-- and an event could be processed against the wrong tenant. A plain
-- UNIQUE would be too strict: a disconnected row keeps its account id for
-- display, and must not block the same customer from rebinding. The
-- partial index constrains exactly the rows that can receive a webhook.
CREATE UNIQUE INDEX IF NOT EXISTS "academy_live_provider_connections_account_live_uniq"
  ON "academy_live_provider_connections" ("provider_key", "external_account_id")
  WHERE "external_account_id" IS NOT NULL
    AND "status" IN ('connected', 'reconnect_required', 'expired');

-- Single-use OAuth state. A row, not a signed cookie: the property needed
-- is SINGLE USE, which is a property of storage rather than of a
-- signature — the same reasoning `live_session_join_grants` follows.
CREATE TABLE IF NOT EXISTS "live_provider_oauth_states" (
  "id"              TEXT NOT NULL,
  "state_hash"      TEXT NOT NULL,
  "academy_id"      TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "user_id"         TEXT NOT NULL,
  "code_verifier"   TEXT,
  "consumed_at"     TIMESTAMP(3),
  "expires_at"      TIMESTAMP(3) NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "live_provider_oauth_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "live_provider_oauth_states_state_hash_key"
  ON "live_provider_oauth_states" ("state_hash");
CREATE INDEX IF NOT EXISTS "live_provider_oauth_states_expires_at_idx"
  ON "live_provider_oauth_states" ("expires_at");

ALTER TABLE "live_provider_oauth_states"
  DROP CONSTRAINT IF EXISTS "live_provider_oauth_states_academy_id_fkey";
ALTER TABLE "live_provider_oauth_states"
  ADD CONSTRAINT "live_provider_oauth_states_academy_id_fkey"
  FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "live_provider_oauth_states"
  DROP CONSTRAINT IF EXISTS "live_provider_oauth_states_user_id_fkey";
ALTER TABLE "live_provider_oauth_states"
  ADD CONSTRAINT "live_provider_oauth_states_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS, matching every other Live Sessions table.
--
-- The state row is written and read by the SAME authenticated Atlas user
-- who started the flow, so the policy is the user-self shape
-- (`live_session_participants_self_select`'s precedent) rather than a
-- tenant policy: the callback is a browser navigation that carries the
-- user's session, not an academy context.
ALTER TABLE "live_provider_oauth_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "live_provider_oauth_states" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "live_provider_oauth_states_self_select" ON "live_provider_oauth_states";
CREATE POLICY "live_provider_oauth_states_self_select" ON "live_provider_oauth_states"
  FOR SELECT
  USING ("live_provider_oauth_states"."user_id"::text = current_setting('app.current_user_id', true));

DROP POLICY IF EXISTS "live_provider_oauth_states_self_insert" ON "live_provider_oauth_states";
CREATE POLICY "live_provider_oauth_states_self_insert" ON "live_provider_oauth_states"
  FOR INSERT
  WITH CHECK ("live_provider_oauth_states"."user_id"::text = current_setting('app.current_user_id', true));

-- Consuming the state is an UPDATE (stamping `consumed_at`), and it must
-- be restricted to the row's own user for the same reason.
DROP POLICY IF EXISTS "live_provider_oauth_states_self_update" ON "live_provider_oauth_states";
CREATE POLICY "live_provider_oauth_states_self_update" ON "live_provider_oauth_states"
  FOR UPDATE
  USING ("live_provider_oauth_states"."user_id"::text = current_setting('app.current_user_id', true));

-- Expired states are swept by the platform owner, read-only elsewhere.
DROP POLICY IF EXISTS "live_provider_oauth_states_platform_delete" ON "live_provider_oauth_states";
CREATE POLICY "live_provider_oauth_states_platform_delete" ON "live_provider_oauth_states"
  FOR DELETE
  USING (is_platform_owner(current_setting('app.current_user_id', true)));
