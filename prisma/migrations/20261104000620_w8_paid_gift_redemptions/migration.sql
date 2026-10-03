-- W8A — durable, append-only record of "this customer has received their
-- gifted setup days".
--
-- ONE ROW PER CUSTOMER IDENTITY, EVER. The identity is the keyed HMAC (v2)
-- of the organization OWNER's canonical email — the same canonicalization
-- (`canonicalizeEmailForAbuse`, alias collapsing included) and the same key
-- as the trial ledger, so the two features agree on who "the same customer"
-- is. The address itself is never stored.
--
-- WHY A SIBLING OF `trial_redemptions` AND NOT A SHARED TABLE. That table's
-- unique key is `subject_hash` alone — one row per subject — and that index
-- is the hardened anti-abuse guarantee for trials. Re-keying it to
-- `(kind, subject_hash)` would touch that guarantee and its tests. A gift
-- is a distinct benefit (a converted trialist still receives it), so it
-- gets its own one-row-per-subject ledger with the identical properties:
--
--   * UNIQUE(subject_hash): the claim is INSERT ... ON CONFLICT DO NOTHING
--     inside the approval transaction. Two simultaneous first payments for
--     the same identity (two organizations, two checkouts) are serialised by
--     this index and exactly one inserts — exactly one gift.
--   * FKs ON DELETE SET NULL: deleting the organization or anonymising the
--     user breaks the link but never erases the redemption, so "delete the
--     account and sign up again" cannot restore eligibility.
--   * REVOKE UPDATE, DELETE from `atlas_app`: append-only for the
--     application. A refund does not restore eligibility; doing so is a
--     deliberate privileged operation.
--   * No RLS: platform-owned anti-abuse state, exactly like
--     `trial_redemptions`; reachable only through `PaidGiftEligibilityService`
--     and never exposed by a controller.
--
-- `payment_id` is a plain reference (no FK) for the same reason as
-- `tenant_subscriptions.gifted_payment_id`.
--
-- REVERSE (privileged, destroys the ledger — only before launch):
--   DROP TABLE "paid_gift_redemptions";

CREATE TABLE "paid_gift_redemptions" (
    "id" TEXT NOT NULL,
    "subject_hash" TEXT NOT NULL,
    "hash_version" SMALLINT NOT NULL DEFAULT 2,
    "organization_id" TEXT,
    "redeemed_by_user_id" TEXT,
    "payment_id" TEXT,
    "plan_key" TEXT,
    "billing_cycle" "subscription_billing_cycle",
    "gifted_days" INTEGER,
    "gifted_starts_at" TIMESTAMP(3),
    "gifted_ends_at" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'approval',
    "redeemed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paid_gift_redemptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "paid_gift_redemptions_source_chk"
        CHECK ("source" IN ('approval', 'gateway', 'backfill')),
    CONSTRAINT "paid_gift_redemptions_hash_version_chk"
        CHECK ("hash_version" IN (1, 2)),
    -- A backfilled row records only that a paid subscription happened before
    -- the ledger existed; it carries no gift (0 days, no dates).
    CONSTRAINT "paid_gift_redemptions_days_chk"
        CHECK ("gifted_days" IS NULL OR "gifted_days" = 0
               OR "gifted_days" BETWEEN 5 AND 15)
);

CREATE UNIQUE INDEX "paid_gift_redemptions_subject_hash_key"
    ON "paid_gift_redemptions"("subject_hash");
CREATE INDEX "paid_gift_redemptions_organization_id_idx"
    ON "paid_gift_redemptions"("organization_id");
CREATE INDEX "paid_gift_redemptions_redeemed_by_user_id_idx"
    ON "paid_gift_redemptions"("redeemed_by_user_id");

ALTER TABLE "paid_gift_redemptions"
    ADD CONSTRAINT "paid_gift_redemptions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "paid_gift_redemptions"
    ADD CONSTRAINT "paid_gift_redemptions_redeemed_by_user_id_fkey"
    FOREIGN KEY ("redeemed_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Append-only for the application role (see header). Referential SET NULL
-- actions run with the table owner's privileges and are unaffected.
REVOKE UPDATE, DELETE ON "paid_gift_redemptions" FROM "atlas_app";
