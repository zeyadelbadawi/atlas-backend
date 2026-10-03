-- W8 D1 — a paid subscription can be cancelled again after it is renewed.
--
-- THE DEFECT. `subscription_cancellations` was UNIQUE (organization_id,
-- kind). A paid cancel sets `cancel_at_period_end`; a renewal
-- (`upsertForPlanPurchase`) clears it. A SECOND paid cancel then hit the
-- unique index, was reported as `alreadyCancelled`, and never set the flag
-- again — the subscription silently kept renewing in the reminder flow.
--
-- THE FIX. Idempotency is kept, but scoped correctly:
--   * a trial is cancelled at most once per organization, ever (unchanged);
--   * a paid subscription is cancelled at most once PER PAID PERIOD, keyed
--     by the period end the cancellation takes effect at (`effective_at`).
--     A double click or a retry inside the same period still conflicts and
--     is reported as `alreadyCancelled`; after a renewal the period end has
--     moved, so the new cancellation is recorded and the flag is set again.
-- The plain (organization_id, kind) index keeps the admin dashboard's
-- grouping/lookup fast.
--
-- SAFE ON EXISTING DATA. The old index guaranteed at most one row per
-- (organization, kind), which trivially satisfies both narrower partial
-- indexes, so they build without conflict. No row is changed.
--
-- REVERSE (only while no organization has two paid rows):
--   DROP INDEX "subscription_cancellations_trial_once_key";
--   DROP INDEX "subscription_cancellations_paid_per_period_key";
--   DROP INDEX "subscription_cancellations_organization_id_kind_idx";
--   CREATE UNIQUE INDEX "subscription_cancellations_organization_id_kind_key"
--     ON "subscription_cancellations"("organization_id", "kind");

DROP INDEX "subscription_cancellations_organization_id_kind_key";

CREATE INDEX "subscription_cancellations_organization_id_kind_idx"
    ON "subscription_cancellations"("organization_id", "kind");

-- Partial unique indexes: Prisma's schema language cannot express them, so
-- they live here (same precedent as the quiz-attempt and Zoom-connection
-- partial indexes). `createMany({ skipDuplicates })` compiles to a
-- target-less ON CONFLICT DO NOTHING, which honours partial unique indexes.
CREATE UNIQUE INDEX "subscription_cancellations_trial_once_key"
    ON "subscription_cancellations"("organization_id")
    WHERE "kind" = 'trial';

CREATE UNIQUE INDEX "subscription_cancellations_paid_per_period_key"
    ON "subscription_cancellations"("organization_id", "effective_at")
    WHERE "kind" = 'paid';
