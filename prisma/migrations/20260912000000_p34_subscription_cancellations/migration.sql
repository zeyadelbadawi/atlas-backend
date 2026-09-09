-- Phase 10.2 — cancellation records for trials and paid subscriptions.
--
-- Atlas had no subscription-cancellation flow at all before this: the
-- only "cancel" endpoint anywhere was for an individual payment. A user
-- could start a trial but had no way to stop one, and there was nowhere
-- to record why anybody left.

CREATE TYPE "subscription_cancellation_kind" AS ENUM ('trial', 'paid');

CREATE TABLE "subscription_cancellations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "kind" "subscription_cancellation_kind" NOT NULL,
    -- A closed-vocabulary reason code, validated server-side against a
    -- fixed list, so the admin dashboard can aggregate it. Free text goes
    -- in `feedback`.
    "reason" TEXT NOT NULL,
    -- Optional, and never required to cancel.
    "feedback" TEXT,
    "cancelled_by_user_id" TEXT,
    "cancelled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- When access actually ends: immediate for a trial, end of the
    -- already-paid period for a paid subscription.
    "effective_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_cancellations_pkey" PRIMARY KEY ("id")
);

-- IDEMPOTENCY, ENFORCED BY THE DATABASE. One cancellation per
-- organization per kind. A double-clicked button, a retried request, or
-- two genuinely concurrent cancellations all collapse to a single row:
-- the second INSERT conflicts, and the service reads that as "already
-- cancelled" rather than raising. No application lock is involved.
CREATE UNIQUE INDEX "subscription_cancellations_organization_id_kind_key"
    ON "subscription_cancellations"("organization_id", "kind");

CREATE INDEX "subscription_cancellations_cancelled_at_idx"
    ON "subscription_cancellations"("cancelled_at" DESC);

ALTER TABLE "subscription_cancellations"
    ADD CONSTRAINT "subscription_cancellations_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull, so deleting the acting user removes the attribution but keeps
-- the cancellation record itself.
ALTER TABLE "subscription_cancellations"
    ADD CONSTRAINT "subscription_cancellations_cancelled_by_user_id_fkey"
    FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- NOTE ON TRIAL ELIGIBILITY. Cancelling does NOT touch
-- `trial_redemptions`. A cancelled trial stays redeemed permanently, so
-- cancelling can never be used to earn a second trial — and the app role
-- has no DELETE privilege on that table anyway (see the p33 migration).
