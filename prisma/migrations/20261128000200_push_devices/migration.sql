-- Atlas mobile app (B1) — push notification devices.
--
-- One row per app install that allowed notifications: its FCM registration
-- token, which academy session registered it, and the app's locale. The
-- push worker sends a notification only to the recipient's devices on the
-- SAME academy (or to all of them for account-wide security notices), and
-- only while the session that registered the device is still alive — so
-- signing out, revoking a session or its expiry stops pushes without any
-- extra bookkeeping.
--
-- RLS. FORCE, own rows only, every command. The worker reads a recipient's
-- devices inside that recipient's own `app.current_user_id` context.
--
-- A TOKEN BELONGS TO ONE PHONE, NOT ONE PERSON. When another account signs
-- in on the same phone and registers the same token, the previous owner's
-- row must go, or the phone keeps receiving their notifications. Own-row RLS
-- cannot see that row, so `release_push_token` (SECURITY DEFINER) deletes
-- rows holding the token that belong to anyone but the caller — and nothing
-- else: it decides from `app.current_user_id`, returns nothing, and reveals
-- nothing about whose row it was.
--
-- PURELY ADDITIVE. A new table and function nothing existing reads; the web
-- is unchanged and the previous release keeps working during the deploy.

CREATE TABLE "push_devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "platform" VARCHAR(16) NOT NULL,
    "token" VARCHAR(4096) NOT NULL,
    "app_version" VARCHAR(32) NOT NULL,
    "locale" VARCHAR(8) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_sent_at" TIMESTAMP(3),

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_devices_token_key" ON "push_devices"("token");
CREATE INDEX "push_devices_user_academy_idx" ON "push_devices"("user_id", "academy_id");

ALTER TABLE "push_devices"
  ADD CONSTRAINT "push_devices_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "push_devices"
  ADD CONSTRAINT "push_devices_academy_id_fkey"
  FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "push_devices"
  ADD CONSTRAINT "push_devices_platform_check" CHECK ("platform" IN ('ios', 'android'));
ALTER TABLE "push_devices"
  ADD CONSTRAINT "push_devices_locale_check" CHECK ("locale" IN ('en', 'ar'));
ALTER TABLE "push_devices"
  ADD CONSTRAINT "push_devices_app_version_format"
  CHECK ("app_version" ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$');

ALTER TABLE "push_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "push_devices" FORCE ROW LEVEL SECURITY;

CREATE POLICY "push_devices_self_select" ON "push_devices"
  FOR SELECT USING ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "push_devices_self_insert" ON "push_devices"
  FOR INSERT WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "push_devices_self_update" ON "push_devices"
  FOR UPDATE USING ("user_id" = current_setting('app.current_user_id', true))
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "push_devices_self_delete" ON "push_devices"
  FOR DELETE USING ("user_id" = current_setting('app.current_user_id', true));

CREATE FUNCTION release_push_token(p_token TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller TEXT := NULLIF(current_setting('app.current_user_id', true), '');
BEGIN
  IF caller IS NULL OR p_token IS NULL THEN
    RETURN;
  END IF;
  DELETE FROM "push_devices" WHERE "token" = p_token AND "user_id" <> caller;
END
$$;

REVOKE ALL ON FUNCTION release_push_token(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_push_token(TEXT) TO "atlas_app";
