-- W8A — gifted setup days, per plan and per billing cycle (catalog config).
--
-- WHAT. Two nullable integer columns on `plans`. `NULL` or `0` means "this
-- plan, on this cycle, carries no gift". Any other value is the number of
-- whole days granted IN FRONT OF the first paid period of a customer's
-- first-ever paid subscription (see `PaymentApplicationService`).
--
-- WHY A CHECK AND NOT ONLY A DTO RULE. The Platform-Owner editor validates
-- 5..15 too, but a gift is money: a typo of 150 would hand out five months.
-- The range is enforced where every writer (seed scripts, ad-hoc SQL, a
-- future second editor) is bound by it.
--
-- PURELY ADDITIVE. Every existing row gets NULL (no gift), so nothing about
-- an existing plan changes. The default values (7 / 14) are applied by a
-- SEPARATE, clearly named migration (20261104000690) so the product decision
-- can be changed or reverted without touching this schema change.
--
-- REVERSE: ALTER TABLE "plans" DROP COLUMN "gifted_days_monthly",
--          DROP COLUMN "gifted_days_yearly";  (constraints go with them)

ALTER TABLE "plans"
    ADD COLUMN "gifted_days_monthly" INTEGER,
    ADD COLUMN "gifted_days_yearly" INTEGER;

ALTER TABLE "plans"
    ADD CONSTRAINT "plans_gifted_days_monthly_range_chk"
    CHECK ("gifted_days_monthly" IS NULL OR "gifted_days_monthly" = 0
           OR "gifted_days_monthly" BETWEEN 5 AND 15);

ALTER TABLE "plans"
    ADD CONSTRAINT "plans_gifted_days_yearly_range_chk"
    CHECK ("gifted_days_yearly" IS NULL OR "gifted_days_yearly" = 0
           OR "gifted_days_yearly" BETWEEN 5 AND 15);

-- `plans` carries no RLS (platform-owned catalog, see the P4 migration); the
-- existing table grants already cover the new columns.
