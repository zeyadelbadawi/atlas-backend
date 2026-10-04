-- =============================================================================
-- W3-compose — one campaign model for every person-authored message.
--
-- Two senders share it: the Platform Owner ("Email & Notifications →
-- Compose and send", scope `platform`) and an academy's owner or
-- administrator ("Messages", scope `academy`). A campaign is the durable
-- intent; it is expanded into `campaign_recipients` in keyset batches and
-- released into the EXISTING `communication_outbox` (linked by
-- `communication_outbox.campaign_id`), so delivery, retries, preferences,
-- suppression and the provider quota stay the dispatcher's single job.
--
-- Additive only: new types, new tables, one nullable column and two
-- indexes on `communication_outbox`. No existing row is changed.
--
-- RLS follows `20261013000000_p64_comm_foundation` exactly: FORCE RLS on
-- every table; the Platform Owner reaches everything through
-- `is_platform_owner(app.current_user_id)` (the dispatcher and the campaign
-- worker run under that context); tenant staff read their organisation's
-- academy campaigns through `app.current_organization_id`. Unlike the
-- outbox there is no `WITH CHECK (true)` insert: an academy campaign may
-- only be created inside its own tenant context, by the acting user.
--
-- Recovery: every object here is new. Dropping them (tables, types, the
-- column, the function) restores the previous schema with no data loss
-- outside this feature.
-- =============================================================================

CREATE TYPE "communication_campaign_scope" AS ENUM ('platform', 'academy');

CREATE TYPE "communication_campaign_status" AS ENUM (
  'queued',      -- accepted (202), not yet expanded
  'expanding',   -- audience being written to campaign_recipients
  'sending',     -- recipients being released / outbox rows being delivered
  'completed',   -- every released outbox row reached a terminal state
  'cancelled',
  'failed'
);

-- ---- communication_campaigns ------------------------------------------------
CREATE TABLE "communication_campaigns" (
  "id"                   TEXT NOT NULL,
  "scope"                "communication_campaign_scope" NOT NULL,
  "organization_id"      TEXT,
  "academy_id"           TEXT,
  "created_by"           TEXT,
  -- Client idempotency: `platform` or `academy:<academy id>` + a client uuid.
  "idempotency_scope"    VARCHAR(80) NOT NULL,
  "idempotency_key"      VARCHAR(100) NOT NULL,
  -- The catalogue key every outbox row of this campaign carries.
  "key"                  VARCHAR(100) NOT NULL,
  "channels"             JSONB NOT NULL,
  "audience"             JSONB NOT NULL,
  "subject"              VARCHAR(150) NOT NULL,
  -- Server-sanitised allowlist HTML and its plain-text twin. Never the
  -- author's raw input.
  "body_html"            TEXT NOT NULL,
  "body_text"            TEXT NOT NULL,
  "content_locale"       VARCHAR(8) NOT NULL DEFAULT 'en',
  "status"               "communication_campaign_status" NOT NULL DEFAULT 'queued',
  -- Counted at send time (and confirmed against the client's preview).
  "recipient_count"      INTEGER NOT NULL DEFAULT 0,
  "expected_email_count" INTEGER NOT NULL DEFAULT 0,
  -- Keyset expansion progress (the last user id written).
  "expansion_cursor"     TEXT,
  "expanded_count"       INTEGER NOT NULL DEFAULT 0,
  -- Real counts of rows written by the release step.
  "email_released_count" INTEGER NOT NULL DEFAULT 0,
  "in_app_released_count" INTEGER NOT NULL DEFAULT 0,
  "excluded_opted_out"   INTEGER NOT NULL DEFAULT 0,
  "excluded_suppressed"  INTEGER NOT NULL DEFAULT 0,
  "excluded_quota"       INTEGER NOT NULL DEFAULT 0,
  -- Academy campaigns only: the monthly email quota reservation.
  "quota_period_start"   TIMESTAMP(3),
  "quota_reserved"       INTEGER NOT NULL DEFAULT 0,
  "large_audience_confirmed" BOOLEAN NOT NULL DEFAULT false,
  "last_error"           VARCHAR(500),
  "started_at"           TIMESTAMP(3),
  "completed_at"         TIMESTAMP(3),
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "communication_campaigns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "communication_campaigns_scope_tenancy_check" CHECK (
    ("scope" = 'platform' AND "academy_id" IS NULL)
    OR ("scope" = 'academy' AND "academy_id" IS NOT NULL AND "organization_id" IS NOT NULL)
  ),
  CONSTRAINT "communication_campaigns_counts_check" CHECK (
    "recipient_count" >= 0 AND "expected_email_count" >= 0 AND "quota_reserved" >= 0
  )
);

ALTER TABLE "communication_campaigns"
  ADD CONSTRAINT "communication_campaigns_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "communication_campaigns"
  ADD CONSTRAINT "communication_campaigns_academy_id_fkey"
  FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "communication_campaigns"
  ADD CONSTRAINT "communication_campaigns_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- UNIQUE(scope, key): a double click or a retried POST returns the first campaign.
CREATE UNIQUE INDEX "communication_campaigns_idempotency_key"
  ON "communication_campaigns"("idempotency_scope", "idempotency_key");
CREATE INDEX "communication_campaigns_academy_id_created_at_idx"
  ON "communication_campaigns"("academy_id", "created_at" DESC, "id" DESC);
CREATE INDEX "communication_campaigns_scope_created_at_idx"
  ON "communication_campaigns"("scope", "created_at" DESC, "id" DESC);
-- The worker's resume scan: only campaigns still in flight.
CREATE INDEX "communication_campaigns_active_idx"
  ON "communication_campaigns"("status", "updated_at")
  WHERE "status" IN ('queued', 'expanding', 'sending');

-- ---- campaign_recipients ------------------------------------------------------
CREATE TABLE "campaign_recipients" (
  "campaign_id"    TEXT NOT NULL,
  "user_id"        TEXT NOT NULL,
  -- false = in-app only for this person (opted out, suppressed, over quota).
  "email_eligible" BOOLEAN NOT NULL,
  -- `opted_out` | `suppressed` | `quota` — why the email was not queued.
  "exclusion"      VARCHAR(32),
  -- 0 = expanded, waiting; 1 = released into the outbox / feed.
  "state"          SMALLINT NOT NULL DEFAULT 0,
  "outbox_id"      TEXT,
  "released_at"    TIMESTAMP(3),

  CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("campaign_id", "user_id")
);

ALTER TABLE "campaign_recipients"
  ADD CONSTRAINT "campaign_recipients_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "communication_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_recipients"
  ADD CONSTRAINT "campaign_recipients_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "campaign_recipients_campaign_id_state_user_id_idx"
  ON "campaign_recipients"("campaign_id", "state", "user_id");

-- ---- communication_outbox.campaign_id -----------------------------------------
-- Nullable, no default, no FK: adding it rewrites nothing and scans nothing.
-- Attribution only — the outbox row stays the delivery record.
ALTER TABLE "communication_outbox" ADD COLUMN "campaign_id" TEXT;
CREATE INDEX "communication_outbox_campaign_id_state_idx"
  ON "communication_outbox"("campaign_id", "state")
  WHERE "campaign_id" IS NOT NULL;

-- ---- tenant_email_usage_periods ----------------------------------------------
-- One row per academy per calendar month (UTC). Created lazily by the first
-- send of the month: there is no rollover job.
CREATE TABLE "tenant_email_usage_periods" (
  "academy_id"      TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "period_start"    TIMESTAMP(3) NOT NULL,
  "period_end"      TIMESTAMP(3) NOT NULL,
  -- The limit in force at the latest reservation; NULL = unlimited.
  "limit_snapshot"  INTEGER,
  "used"            INTEGER NOT NULL DEFAULT 0,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tenant_email_usage_periods_pkey" PRIMARY KEY ("academy_id", "period_start"),
  CONSTRAINT "tenant_email_usage_periods_used_check" CHECK ("used" >= 0)
);

ALTER TABLE "tenant_email_usage_periods"
  ADD CONSTRAINT "tenant_email_usage_periods_academy_id_fkey"
  FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_email_usage_periods"
  ADD CONSTRAINT "tenant_email_usage_periods_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---- tenant_email_usage_ledger ------------------------------------------------
-- Append-only movements against a period. UNIQUE(message_id, kind): one
-- charge, one release (unused reservation) and one refund (terminal
-- failures) per message, so a retried step can never move the counter twice.
CREATE TABLE "tenant_email_usage_ledger" (
  "id"              TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "academy_id"      TEXT NOT NULL,
  "period_start"    TIMESTAMP(3) NOT NULL,
  "message_id"      TEXT NOT NULL,
  "kind"            VARCHAR(16) NOT NULL,
  "quantity"        INTEGER NOT NULL,
  "created_by"      TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tenant_email_usage_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_email_usage_ledger_kind_check" CHECK ("kind" IN ('charge', 'release', 'refund')),
  CONSTRAINT "tenant_email_usage_ledger_quantity_check" CHECK ("quantity" >= 0)
);

ALTER TABLE "tenant_email_usage_ledger"
  ADD CONSTRAINT "tenant_email_usage_ledger_academy_id_fkey"
  FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_email_usage_ledger"
  ADD CONSTRAINT "tenant_email_usage_ledger_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "tenant_email_usage_ledger_message_id_kind_key"
  ON "tenant_email_usage_ledger"("message_id", "kind");
CREATE INDEX "tenant_email_usage_ledger_academy_id_period_start_idx"
  ON "tenant_email_usage_ledger"("academy_id", "period_start");

-- =============================================================================
-- Row-level security
-- =============================================================================

-- ---- communication_campaigns
ALTER TABLE "communication_campaigns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "communication_campaigns" FORCE ROW LEVEL SECURITY;
CREATE POLICY "communication_campaigns_platform_select" ON "communication_campaigns"
  FOR SELECT USING (is_platform_owner(current_setting('app.current_user_id', true)));
CREATE POLICY "communication_campaigns_platform_insert" ON "communication_campaigns"
  FOR INSERT WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));
CREATE POLICY "communication_campaigns_platform_update" ON "communication_campaigns"
  FOR UPDATE USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));
CREATE POLICY "communication_campaigns_tenant_select" ON "communication_campaigns"
  FOR SELECT USING (
    "scope" = 'academy'
    AND "organization_id" IS NOT NULL
    AND "organization_id"::text = current_setting('app.current_organization_id', true));
-- An academy campaign is written only by its author, inside that tenant.
CREATE POLICY "communication_campaigns_tenant_insert" ON "communication_campaigns"
  FOR INSERT WITH CHECK (
    "scope" = 'academy'
    AND "organization_id"::text = current_setting('app.current_organization_id', true)
    AND "created_by"::text = current_setting('app.current_user_id', true));

-- ---- campaign_recipients
ALTER TABLE "campaign_recipients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "campaign_recipients" FORCE ROW LEVEL SECURITY;
CREATE POLICY "campaign_recipients_platform_all" ON "campaign_recipients"
  FOR ALL USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));
CREATE POLICY "campaign_recipients_tenant_select" ON "campaign_recipients"
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM "communication_campaigns" c
    WHERE c."id" = "campaign_recipients"."campaign_id"
      AND c."scope" = 'academy'
      AND c."organization_id"::text = current_setting('app.current_organization_id', true)));

-- ---- tenant_email_usage_periods
ALTER TABLE "tenant_email_usage_periods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_email_usage_periods" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_email_usage_periods_tenant_select" ON "tenant_email_usage_periods"
  FOR SELECT USING ("organization_id"::text = current_setting('app.current_organization_id', true));
CREATE POLICY "tenant_email_usage_periods_tenant_insert" ON "tenant_email_usage_periods"
  FOR INSERT WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));
CREATE POLICY "tenant_email_usage_periods_tenant_update" ON "tenant_email_usage_periods"
  FOR UPDATE USING ("organization_id"::text = current_setting('app.current_organization_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));
CREATE POLICY "tenant_email_usage_periods_platform_all" ON "tenant_email_usage_periods"
  FOR ALL USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

-- ---- tenant_email_usage_ledger
ALTER TABLE "tenant_email_usage_ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_email_usage_ledger" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_email_usage_ledger_tenant_select" ON "tenant_email_usage_ledger"
  FOR SELECT USING ("organization_id"::text = current_setting('app.current_organization_id', true));
CREATE POLICY "tenant_email_usage_ledger_tenant_insert" ON "tenant_email_usage_ledger"
  FOR INSERT WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));
CREATE POLICY "tenant_email_usage_ledger_platform_all" ON "tenant_email_usage_ledger"
  FOR ALL USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

-- =============================================================================
-- communication_email_suppressed(email) — the suppression list as a boolean.
--
-- `communication_suppressions` is platform data (only a Platform Owner may
-- read it), but an academy composer's preview has to COUNT how many of its
-- own recipients are suppressed, inside the tenant's context. This answers
-- exactly that question for one address and nothing else: no hash, no
-- reason, no row. Same canonicalisation as `SuppressionService.hashEmail`
-- (trim + lower-case, SHA-256 hex). Only `atlas_app` may execute it.
-- =============================================================================
CREATE OR REPLACE FUNCTION communication_email_suppressed(p_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "communication_suppressions" s
    WHERE s."email_hash" = encode(sha256(convert_to(lower(btrim(p_email)), 'UTF8')), 'hex')
      AND (s."expires_at" IS NULL OR s."expires_at" > now())
  );
$$;

REVOKE ALL ON FUNCTION communication_email_suppressed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION communication_email_suppressed(text) TO "atlas_app";
