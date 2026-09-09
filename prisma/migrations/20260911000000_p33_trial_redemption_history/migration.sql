-- Phase 10.1 — durable Free-Trial redemption history.
--
-- THE PROBLEM THIS SOLVES. Before this migration, a trial was granted
-- unconditionally to every newly created Organization, and nothing
-- recorded that it had happened. One authenticated user could create
-- organization after organization and collect a fresh 3-day trial each
-- time — verified against the running application, three trials in under
-- a second, with no change of email, device, browser, IP or network. The
-- trial state also lived on `tenant_subscriptions`, which cascades on
-- organization delete, so any history it implied was destroyed along
-- with the organization.
--
-- `trial_redemptions` is the durable counterpart: one row per subject
-- that has ever consumed a trial, outliving both the organization and
-- the user it referenced.

CREATE TABLE "trial_redemptions" (
    "id" TEXT NOT NULL,
    -- Salted SHA-256 of the canonical email (see `trial-subject.util.ts`).
    -- The address itself is never stored, so this table cannot be mined
    -- for user email addresses.
    "subject_hash" TEXT NOT NULL,
    "organization_id" TEXT,
    "redeemed_by_user_id" TEXT,
    "redeemed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trial_ends_at" TIMESTAMP(3),
    -- Forensic signals only. Deliberately NOT consulted by the
    -- eligibility decision: blocking on a shared address would lock out
    -- every user behind one corporate NAT, university, or mobile carrier.
    "ip_address" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "trial_redemptions_pkey" PRIMARY KEY ("id")
);

-- THE ENFORCEMENT MECHANISM. Concurrency safety comes from this index,
-- not from application code: two simultaneous organization-creation
-- requests for the same subject both attempt the INSERT, Postgres
-- serialises them, and exactly one succeeds. The loser sees a unique
-- violation and is denied a trial. No advisory lock, no read-then-write
-- window for a race to slip through.
CREATE UNIQUE INDEX "trial_redemptions_subject_hash_key"
    ON "trial_redemptions"("subject_hash");

CREATE INDEX "trial_redemptions_organization_id_idx"
    ON "trial_redemptions"("organization_id");
CREATE INDEX "trial_redemptions_redeemed_by_user_id_idx"
    ON "trial_redemptions"("redeemed_by_user_id");

-- SET NULL, never CASCADE. Deleting the organization or the user must
-- break the link WITHOUT erasing the redemption — otherwise "delete the
-- organization and make another one" trivially resets eligibility, which
-- is the exact abuse this table exists to stop.
ALTER TABLE "trial_redemptions"
    ADD CONSTRAINT "trial_redemptions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "trial_redemptions"
    ADD CONSTRAINT "trial_redemptions_redeemed_by_user_id_fkey"
    FOREIGN KEY ("redeemed_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- APPEND-ONLY AT THE DATABASE LEVEL.
--
-- The blanket `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` from
-- the P2 RLS migration (and its matching DEFAULT PRIVILEGES) would
-- otherwise let the application delete or rewrite redemption rows. This
-- is security-and-billing-critical history, so the privilege is removed
-- rather than merely "not used": a future bug, a careless cascade, or a
-- compromised application role cannot erase the record of a consumed
-- trial, because `atlas_app` has no DELETE or UPDATE privilege on this
-- table at all.
--
-- The ON DELETE SET NULL actions above are unaffected — referential
-- integrity actions execute with the privileges of the table owner, not
-- those of the invoking role.
--
-- Correcting a genuine mistake therefore requires a deliberate,
-- privileged, out-of-band operation, which is the intended bar.
REVOKE UPDATE, DELETE ON "trial_redemptions" FROM "atlas_app";

-- `trial_redemptions` is PLATFORM-owned anti-abuse state, not
-- tenant-scoped data — no RLS, matching the identical precedent set by
-- `trial_policy`, `plans` and `schema_meta`. It is reachable only through
-- `TrialEligibilityService`; no controller exposes it.
