-- Google Identity — Phase 1 foundation (docs/GOOGLE_IDENTITY.md).
--
-- Additive only. Nothing existing is rewritten or backfilled:
--   * `user_auth_identities` — an external identity (Google `sub`) bound to
--     ONE global Atlas account. Keyed by (provider, subject), never by
--     email. No RLS, exactly like the other platform-scoped credential
--     tables (`users`, `refresh_tokens`, `user_two_factor`): it is read
--     before any user context exists and carries no tenant id.
--   * `auth_oauth_flows` — one provider sign-in attempt; hashed single-use
--     secrets, server-derived origin host/academy; FORCE RLS with the
--     server-side-only policies `auth_email_challenges` uses, and a 24 h
--     retention delete so the short-lived provider claims do not linger.
--   * `refresh_tokens.auth_method`, `auth_email_challenges.auth_method` —
--     the session's first factor (`password` | `google`). NULL on every
--     existing row (honestly unknown; no guessed backfill).
--
-- Rollback: drop the two tables, the two columns and the two types. The
-- feature is inert until FLAG_AUTH_GOOGLE_MODE leaves `off`.

-- CreateEnum
CREATE TYPE "auth_method" AS ENUM ('password', 'google');

-- CreateEnum
CREATE TYPE "auth_identity_provider" AS ENUM ('google');

-- AlterTable
ALTER TABLE "auth_email_challenges" ADD COLUMN     "auth_method" "auth_method";

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "auth_method" "auth_method";

-- CreateTable
CREATE TABLE "user_auth_identities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" "auth_identity_provider" NOT NULL,
    "provider_subject" VARCHAR(255) NOT NULL,
    "email_at_link" TEXT NOT NULL,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "user_auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_oauth_flows" (
    "id" TEXT NOT NULL,
    "provider" "auth_identity_provider" NOT NULL,
    "state_hash" TEXT NOT NULL,
    "nonce_hash" TEXT NOT NULL,
    "binder_hash" TEXT NOT NULL,
    "code_verifier" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "academy_id" TEXT,
    "origin_host" TEXT NOT NULL,
    "return_path" TEXT,
    "link_user_id" TEXT,
    "provider_subject" VARCHAR(255),
    "provider_email" TEXT,
    "provider_email_verified" BOOLEAN,
    "provider_hosted_domain" TEXT,
    "provider_name" TEXT,
    "handoff_hash" TEXT,
    "handoff_expires_at" TIMESTAMP(3),
    "callback_at" TIMESTAMP(3),
    "handed_off_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "ip_address" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_oauth_flows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_auth_identities_provider_provider_subject_key" ON "user_auth_identities"("provider", "provider_subject");

-- CreateIndex
CREATE UNIQUE INDEX "user_auth_identities_user_id_provider_key" ON "user_auth_identities"("user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "auth_oauth_flows_state_hash_key" ON "auth_oauth_flows"("state_hash");

-- CreateIndex
CREATE UNIQUE INDEX "auth_oauth_flows_handoff_hash_key" ON "auth_oauth_flows"("handoff_hash");

-- CreateIndex
CREATE INDEX "auth_oauth_flows_expires_at_idx" ON "auth_oauth_flows"("expires_at");

-- AddForeignKey
ALTER TABLE "user_auth_identities" ADD CONSTRAINT "user_auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauth_flows" ADD CONSTRAINT "auth_oauth_flows_link_user_id_fkey" FOREIGN KEY ("link_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---- auth_oauth_flows (server-side only; no user read) --------------------
ALTER TABLE "auth_oauth_flows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_oauth_flows" FORCE ROW LEVEL SECURITY;
CREATE POLICY "auth_oauth_flows_system_insert" ON "auth_oauth_flows"
  FOR INSERT WITH CHECK (true);
CREATE POLICY "auth_oauth_flows_system_select" ON "auth_oauth_flows"
  FOR SELECT USING (true);
CREATE POLICY "auth_oauth_flows_system_update" ON "auth_oauth_flows"
  FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "auth_oauth_flows_retention_delete" ON "auth_oauth_flows"
  FOR DELETE USING ("created_at" < now() - INTERVAL '24 hours');
