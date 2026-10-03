-- TASK 7 — Atlas marketing homepage contact form.
--
-- One row per enquiry a visitor sends from the Atlas marketing site
-- (`POST public/contact`). The inbox belongs to Atlas itself, not to any
-- tenant: there is no organization and no academy on the row, and only a
-- Platform Owner can read, triage or delete it
-- (`platform/contact-submissions`).
--
-- PRIVACY. The client address is never stored. `ip_hash` is a keyed
-- SHA-256 (HMAC) of it, enough to correlate abuse from one source without
-- holding the address itself. `organization_name` is not called `company`
-- because `company` is the public form's honeypot field.

CREATE TYPE "platform_contact_topic" AS ENUM ('sales', 'support', 'partnership', 'other');

CREATE TYPE "platform_contact_submission_status" AS ENUM ('new', 'read', 'archived');

CREATE TABLE "platform_contact_submissions" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "organization_name" VARCHAR(200),
    "topic" "platform_contact_topic" NOT NULL,
    "message" VARCHAR(5000) NOT NULL,
    "locale" VARCHAR(8) NOT NULL,
    "source_path" VARCHAR(512),
    "status" "platform_contact_submission_status" NOT NULL DEFAULT 'new',
    "ip_hash" VARCHAR(64) NOT NULL,
    "user_agent" VARCHAR(512),
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_contact_submissions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_contact_submissions_status_created_at_idx"
  ON "platform_contact_submissions"("status", "created_at" DESC);

CREATE INDEX "platform_contact_submissions_created_at_idx"
  ON "platform_contact_submissions"("created_at" DESC);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- INSERT: anonymous only. The public endpoint writes from a transaction
-- with NO context variable set (`TenancyContextService.runWithoutContext`),
-- and that is the only shape of insert this table accepts: a signed-in
-- session (user or tenant context) cannot plant rows here, and every new
-- row must start untriaged. The intake path never reads the row back
-- (no RETURNING), because an anonymous caller has — correctly — no SELECT.
--
-- SELECT / UPDATE / DELETE: Platform Owners only, through the existing
-- `is_platform_owner(text)` SECURITY DEFINER function, exactly like
-- `support_cases_platform_*`. A tenant user, a learner and an anonymous
-- caller all see zero rows.

ALTER TABLE "platform_contact_submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_contact_submissions" FORCE ROW LEVEL SECURITY;

CREATE POLICY "platform_contact_submissions_anonymous_insert" ON "platform_contact_submissions"
  FOR INSERT
  WITH CHECK (
    COALESCE(current_setting('app.current_user_id', true), '') = ''
    AND COALESCE(current_setting('app.current_organization_id', true), '') = ''
    AND "status" = 'new'
    AND "read_at" IS NULL
  );

CREATE POLICY "platform_contact_submissions_platform_select" ON "platform_contact_submissions"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "platform_contact_submissions_platform_update" ON "platform_contact_submissions"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "platform_contact_submissions_platform_delete" ON "platform_contact_submissions"
  FOR DELETE
  USING (is_platform_owner(current_setting('app.current_user_id', true)));
