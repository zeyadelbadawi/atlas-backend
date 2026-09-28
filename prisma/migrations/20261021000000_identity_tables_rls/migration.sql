-- Authentication audit, Decision 2 — row-level security on the identity
-- tables.
--
-- THE GAP. Every tenant table in this schema has FORCE ROW LEVEL SECURITY
-- under the NOBYPASSRLS application role `atlas_app`, so a query that forgets
-- its `organization_id`/`user_id` predicate is contained by the database. The
-- identity tables were the exception: `users`, `refresh_tokens`,
-- `password_reset_tokens`, `email_verification_tokens`, `user_two_factor`,
-- `two_factor_recovery_codes` and `user_auth_identities` had no RLS at all, so
-- the ONLY thing keeping one account's session hashes, TOTP secrets and
-- recovery codes away from another was the predicate in the service layer —
-- one gate, on the tables that matter most.
--
-- THE MODEL.
--
--   1. CREDENTIAL TABLES (the six token/factor tables) are strictly
--      PER-USER: every command is admitted only when the row's `user_id`
--      equals `app.current_user_id`. There is no platform-owner policy and
--      no `USING (true)` anywhere — nobody, the Platform Owner included, has
--      a reason to read another account's session hashes or factors, and a
--      support question about them is answered by counts the owner's own
--      context computes.
--
--   2. PRE-AUTHENTICATION ENTRY is the one place the owner is not yet known
--      (a sign-in names an email; a refresh, reset or verification presents a
--      token; a Google callback presents a subject). It goes through the
--      narrow SECURITY DEFINER resolvers below, which map a lookup key to an
--      OWNER ID AND NOTHING ELSE. Every read and write that follows runs in
--      that owner's own context under the policies above. The token
--      resolvers take the SHA-256 of a secret only its holder has, so they
--      cannot be used to walk the table; none of them returns a hash, a
--      secret, a factor or a profile column. They are `STABLE` (they cannot
--      write), pin `search_path`, and only `atlas_app` may execute them —
--      the same shape as `is_platform_owner` and
--      `academy_notification_recipients`. In application code they are
--      called from exactly one class, `IdentityResolver`, so the whole
--      pre-authentication surface is one greppable, reviewable file.
--
--   3. `users` is the identity DIRECTORY: tenant rosters, reviews,
--      certificates, audit actors and search all join to it, legitimately,
--      for other people's names. Row-scoping its SELECT would mean encoding
--      the whole membership graph into one policy and would fail closed as
--      a 500 on every roster the day a relationship is missed. So:
--        - SELECT requires an ESTABLISHED context (a user or a tenant). A
--          context-less query sees no rows, exactly like every other table;
--          the owner of an email is found through the resolver.
--        - WRITES are self-scoped: an account can change only its own row;
--          the Platform Owner can change any (the console's suspend/restore
--          path). A new row must carry its own id as the context — except
--          a staff-created `invited` account inside a tenant context (the
--          member-add path), and no insert can create a platform owner.
--        - `is_platform_owner`, `id` and `created_at` are not updatable by
--          the application role at all (column privileges): promotion to
--          platform owner is an operator action, never an application one.
--
-- WHY THE APPLICATION ROLE CANNOT BYPASS THIS. `atlas_app` is NOSUPERUSER
-- NOBYPASSRLS (P2 migration) and does not own these tables; FORCE ROW LEVEL
-- SECURITY applies the policies to the owner as well. Foreign-key checks and
-- cascades are performed by PostgreSQL's referential-integrity machinery,
-- which is not subject to RLS, so `ON DELETE CASCADE` from `users` keeps
-- working. The resolvers run as the owning role; that is the documented,
-- auditable crossing, and it yields ids only.

-- ---------------------------------------------------------------------------
-- 1. Credential tables — strictly per-user.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'refresh_tokens',
    'password_reset_tokens',
    'email_verification_tokens',
    'user_two_factor',
    'two_factor_recovery_codes',
    'user_auth_identities'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING ("user_id" = current_setting(''app.current_user_id'', true))',
      t || '_self_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK ("user_id" = current_setting(''app.current_user_id'', true))',
      t || '_self_insert', t);
    -- WITH CHECK repeats the predicate: an UPDATE cannot hand a row to
    -- another account on its way out.
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING ("user_id" = current_setting(''app.current_user_id'', true)) WITH CHECK ("user_id" = current_setting(''app.current_user_id'', true))',
      t || '_self_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE USING ("user_id" = current_setting(''app.current_user_id'', true))',
      t || '_self_delete', t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. users — the directory.
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;

-- Readable only inside an established user or tenant context.
CREATE POLICY "users_context_select" ON "users"
  FOR SELECT USING (
    COALESCE(current_setting('app.current_user_id', true), '') <> ''
    OR COALESCE(current_setting('app.current_organization_id', true), '') <> ''
  );

-- A new account is inserted in its own (pre-generated) id's context.
CREATE POLICY "users_self_insert" ON "users"
  FOR INSERT WITH CHECK (
    "id" = current_setting('app.current_user_id', true)
    AND "is_platform_owner" = false
  );

-- Staff adding a member who has no account yet create an `invited` one
-- inside their tenant context; it cannot sign in until its owner sets a
-- password through the emailed link.
CREATE POLICY "users_tenant_invited_insert" ON "users"
  FOR INSERT WITH CHECK (
    COALESCE(current_setting('app.current_organization_id', true), '') <> ''
    AND "status" = 'invited'
    AND "is_platform_owner" = false
  );

CREATE POLICY "users_self_update" ON "users"
  FOR UPDATE
  USING ("id" = current_setting('app.current_user_id', true))
  WITH CHECK ("id" = current_setting('app.current_user_id', true));

CREATE POLICY "users_platform_update" ON "users"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "users_platform_delete" ON "users"
  FOR DELETE USING (is_platform_owner(current_setting('app.current_user_id', true)));

-- Column privileges: the application may update profile, credential,
-- lifecycle and bookkeeping columns — never identity or privilege.
REVOKE UPDATE ON "users" FROM "atlas_app";
GRANT UPDATE (
  "email",
  "password_hash",
  "name",
  "avatar_url",
  "preferences",
  "status",
  "email_verified_at",
  "deleted_at",
  "deletion_reason",
  "deletion_feedback",
  "last_sign_in_at",
  "updated_at"
) ON "users" TO "atlas_app";

-- ---------------------------------------------------------------------------
-- 3. Pre-authentication resolvers — owner ids only.
-- ---------------------------------------------------------------------------

-- Sign-in, registration, password-reset request, Google email match.
CREATE FUNCTION auth_user_id_by_email(p_email text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u."id" FROM "users" u WHERE u."email" = p_email;
$$;

-- Refresh and sign-out: the SHA-256 of the refresh token the client holds.
CREATE FUNCTION auth_refresh_token_owner(p_token_hash text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT rt."user_id" FROM "refresh_tokens" rt WHERE rt."token_hash" = p_token_hash;
$$;

-- Password reset / account setup confirmation: the emailed token's hash.
CREATE FUNCTION auth_password_reset_token_owner(p_token_hash text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT prt."user_id" FROM "password_reset_tokens" prt WHERE prt."token_hash" = p_token_hash;
$$;

-- Email verification: the emailed token's hash.
CREATE FUNCTION auth_email_verification_token_owner(p_token_hash text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT evt."user_id" FROM "email_verification_tokens" evt WHERE evt."token_hash" = p_token_hash;
$$;

-- Federated sign-in: the provider's stable subject for this person.
CREATE FUNCTION auth_identity_owner(p_provider text, p_subject text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i."user_id" FROM "user_auth_identities" i
   WHERE i."provider"::text = p_provider AND i."provider_subject" = p_subject;
$$;

-- Background jobs that act under the Platform Owner context (retention
-- sweeps, the webhook suppression path) need one platform-owner id to open
-- it. Which one does not matter: `is_platform_owner(uid)` checks the flag.
CREATE FUNCTION platform_owner_user_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u."id" FROM "users" u
   WHERE u."is_platform_owner" = true
   ORDER BY u."created_at" ASC
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION auth_user_id_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_refresh_token_owner(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_password_reset_token_owner(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_email_verification_token_owner(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_identity_owner(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_owner_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_user_id_by_email(text) TO "atlas_app";
GRANT EXECUTE ON FUNCTION auth_refresh_token_owner(text) TO "atlas_app";
GRANT EXECUTE ON FUNCTION auth_password_reset_token_owner(text) TO "atlas_app";
GRANT EXECUTE ON FUNCTION auth_email_verification_token_owner(text) TO "atlas_app";
GRANT EXECUTE ON FUNCTION auth_identity_owner(text, text) TO "atlas_app";
GRANT EXECUTE ON FUNCTION platform_owner_user_id() TO "atlas_app";

-- ---------------------------------------------------------------------------
-- 4. The one staff-facing read of another account's sessions.
-- ---------------------------------------------------------------------------
-- The academy roster shows staff how many live sessions a learner holds.
-- With `refresh_tokens` strictly per-user, staff cannot count them directly
-- — correctly: they must never read a session row. This returns a COUNT and
-- nothing else, only to a viewer `can_view_academy_student()` already admits
-- to that learner's roster entry (the same rule the roster's own RLS uses),
-- and only for sessions on THIS academy's surface. (The count used to include
-- the learner's sessions anywhere on the platform — other organizations'
-- dashboards included — which was never this academy's business.)
CREATE FUNCTION academy_student_session_count(p_academy_id text, p_student_user_id text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN can_view_academy_student(
      p_academy_id,
      p_student_user_id,
      current_setting('app.current_user_id', true)
    )
    THEN (
      SELECT count(DISTINCT rt."session_id")::integer
        FROM "refresh_tokens" rt
       WHERE rt."user_id" = p_student_user_id
         AND rt."academy_id" = p_academy_id
         AND rt."surface" = 'academy'
         AND rt."revoked_at" IS NULL
         AND rt."expires_at" > now()
    )
    ELSE 0
  END;
$$;

REVOKE ALL ON FUNCTION academy_student_session_count(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION academy_student_session_count(text, text) TO "atlas_app";
