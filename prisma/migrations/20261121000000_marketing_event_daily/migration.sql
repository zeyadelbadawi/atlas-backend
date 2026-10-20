-- B1 F.5 — the cookieless marketing beacon (`POST /api/v1/mkt/events`).
--
-- Additive: one new table, nothing else changes. DAILY AGGREGATE counts
-- only — one row per UTC day and combination of closed-vocabulary
-- dimensions (`src/marketing-events/marketing-events.vocabulary.ts`). No
-- visitor, session or device identifier, no IP address, no URL, query or
-- fragment is stored; `referrer_domain` is a bare hostname or ''.
--
-- Ingestion increments with `INSERT … ON CONFLICT DO UPDATE` on the
-- primary key, so concurrent beacons from several instances never race.
-- Retention: rows older than 25 months are deleted by the daily
-- `marketing-events-retention` job.
--
-- No RLS: platform-level counts with no tenant data, exactly like
-- `tenant_usage_sweep_cursor` and `trial_policy`. `atlas_app` gets
-- SELECT/INSERT/UPDATE/DELETE through the schema's default privileges
-- (20260823183500_p2_app_role_rls_enforcement).

CREATE TABLE "marketing_event_daily" (
    "day" DATE NOT NULL,
    "name" VARCHAR(32) NOT NULL,
    "page" VARCHAR(24) NOT NULL,
    "locale" VARCHAR(2) NOT NULL,
    "device" VARCHAR(8) NOT NULL,
    "value" VARCHAR(32) NOT NULL DEFAULT '',
    "utm_source" VARCHAR(32) NOT NULL DEFAULT '',
    "utm_medium" VARCHAR(32) NOT NULL DEFAULT '',
    "utm_campaign" VARCHAR(32) NOT NULL DEFAULT '',
    "referrer_domain" VARCHAR(100) NOT NULL DEFAULT '',
    "count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_event_daily_pkey" PRIMARY KEY ("day","name","page","locale","device","value","utm_source","utm_medium","utm_campaign","referrer_domain")
);
