-- W8A — the gifted segment as granted to one subscription.
--
-- `tenant_subscriptions` is one row per organization and is overwritten on
-- every purchase, so the gift must live in columns that a later renewal,
-- plan change or cancellation never clears (`upsertForPlanPurchase` writes
-- them only on the gift-granting call). The durable, cross-organization
-- record of "this customer already had their gift" is `paid_gift_redemptions`
-- (next migration); these columns are the per-subscription display/audit
-- facts:
--
--   gifted_days        N, as granted (5..15)
--   gifted_starts_at   approval instant
--   gifted_ends_at     approval + N x 24h == the start of the paid period
--   gifted_payment_id  the payment whose approval granted it (plain id)
--
-- The shape CHECK keeps the three facts all-or-nothing, so no reader ever
-- sees "a gift with no end".
--
-- RLS: the table's existing FORCE RLS tenant policies already cover every
-- column; nothing to add.
--
-- REVERSE: ALTER TABLE "tenant_subscriptions" DROP COLUMN "gifted_days",
--          DROP COLUMN "gifted_starts_at", DROP COLUMN "gifted_ends_at",
--          DROP COLUMN "gifted_payment_id";

ALTER TABLE "tenant_subscriptions"
    ADD COLUMN "gifted_days" INTEGER,
    ADD COLUMN "gifted_starts_at" TIMESTAMP(3),
    ADD COLUMN "gifted_ends_at" TIMESTAMP(3),
    ADD COLUMN "gifted_payment_id" TEXT;

ALTER TABLE "tenant_subscriptions"
    ADD CONSTRAINT "tenant_subscriptions_gift_shape_chk"
    CHECK (
      ("gifted_days" IS NULL AND "gifted_starts_at" IS NULL AND "gifted_ends_at" IS NULL)
      OR ("gifted_days" BETWEEN 5 AND 15
          AND "gifted_starts_at" IS NOT NULL
          AND "gifted_ends_at" IS NOT NULL
          AND "gifted_ends_at" > "gifted_starts_at")
    );

-- `gifted_payment_id` is deliberately a plain reference, not a foreign key:
-- the gift facts must never depend on (or block changes to) a payment row,
-- and payments are never deleted in practice. It is display/audit data.
