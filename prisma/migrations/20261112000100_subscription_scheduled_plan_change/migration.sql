-- B0-BIL-04 — a downgrade bought mid-period takes effect at the end of the
-- period the customer already paid for. Additive and nullable: existing
-- rows are untouched, and a NULL schedule means "no change pending".
ALTER TABLE "tenant_subscriptions" ADD COLUMN "scheduled_plan_id" TEXT;
ALTER TABLE "tenant_subscriptions" ADD COLUMN "scheduled_granted_limits" JSONB;
ALTER TABLE "tenant_subscriptions" ADD COLUMN "scheduled_change_at" TIMESTAMP(3);

-- All three set together or all three NULL.
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_scheduled_change_shape_chk"
  CHECK (
    ("scheduled_plan_id" IS NULL AND "scheduled_granted_limits" IS NULL AND "scheduled_change_at" IS NULL)
    OR ("scheduled_plan_id" IS NOT NULL AND "scheduled_granted_limits" IS NOT NULL AND "scheduled_change_at" IS NOT NULL)
  );

CREATE INDEX "tenant_subscriptions_scheduled_change_at_idx" ON "tenant_subscriptions"("scheduled_change_at");
