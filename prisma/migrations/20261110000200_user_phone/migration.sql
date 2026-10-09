-- Phone number on sign-up and profile.
--
-- WHERE IT LIVES. Not on `users`. `users` is the identity DIRECTORY: rosters,
-- reviews, certificates, audit actors, search and the platform console all
-- read it inside any established context (20261021000000_identity_tables_rls).
-- A phone number on that row would reach every one of those reads — one
-- `include: { user: true }` away from a member list. Exactly the reasoning
-- that moved the password credential off the row
-- (20261022000000_user_credentials): the number gets its own table, admitted
-- only in the owner's own `app.current_user_id` context for every command.
-- No Platform Owner, staff or organization-owner policy: no current feature
-- needs anyone else to read it, and adding one later is a deliberate,
-- reviewable migration rather than a side effect.
--
-- WHAT IS STORED. The E.164 form normalised by the server (libphonenumber —
-- never the client's normalisation), the ISO 3166-1 alpha-2 country the
-- person picked (one calling code can serve several countries: +1, +7, +44),
-- and when the number was verified (NULL = unverified; nothing verifies it
-- yet — there is no SMS/WhatsApp provider).
--
-- NOT UNIQUE. Families and small businesses share one number; a uniqueness
-- rule would also turn sign-up into a "is this number registered?" oracle.
--
-- PURELY ADDITIVE. A new table; the previous release never reads it, so the
-- deploy window (migration runs while the old container still serves) is
-- safe in both directions.

CREATE TABLE "user_phones" (
    "user_id" TEXT NOT NULL,
    "phone_e164" VARCHAR(16) NOT NULL,
    "country_code" VARCHAR(2) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_phones_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "user_phones"
  ADD CONSTRAINT "user_phones_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Last line of defence against a code path that skips normalisation: only an
-- E.164 string (a '+', a non-zero first digit, 7–15 digits in all — ITU-T
-- E.164 allows at most 15) and an upper-case alpha-2 country are storable.
ALTER TABLE "user_phones"
  ADD CONSTRAINT "user_phones_phone_e164_format"
  CHECK ("phone_e164" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "user_phones"
  ADD CONSTRAINT "user_phones_country_code_format"
  CHECK ("country_code" ~ '^[A-Z]{2}$');

ALTER TABLE "user_phones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_phones" FORCE ROW LEVEL SECURITY;

CREATE POLICY "user_phones_self_select" ON "user_phones"
  FOR SELECT USING ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "user_phones_self_insert" ON "user_phones"
  FOR INSERT WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "user_phones_self_update" ON "user_phones"
  FOR UPDATE USING ("user_id" = current_setting('app.current_user_id', true))
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "user_phones_self_delete" ON "user_phones"
  FOR DELETE USING ("user_id" = current_setting('app.current_user_id', true));

-- A verification proves ONE number. Whatever code path changes the number,
-- the proof does not carry over: the database clears it, so "changing the
-- number clears verification" holds even for a writer that forgets.
CREATE FUNCTION user_phones_clear_verification_on_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW."phone_e164" IS DISTINCT FROM OLD."phone_e164" THEN
    NEW."verified_at" := NULL;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION user_phones_clear_verification_on_change() FROM PUBLIC;

CREATE TRIGGER "user_phones_clear_verification_on_change"
  BEFORE UPDATE OF "phone_e164" ON "user_phones"
  FOR EACH ROW EXECUTE FUNCTION user_phones_clear_verification_on_change();
