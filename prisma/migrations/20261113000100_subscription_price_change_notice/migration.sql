-- B0-BIL-07 — notice to existing subscribers that their plan's renewal
-- price or limits changed. Additive and nullable: existing rows are
-- untouched, and a NULL notice means "nothing to tell this customer".
-- The notice is cleared by the next paid purchase (the renewal it was
-- about); dismissal only hides the banner and keeps the record.
ALTER TABLE "tenant_subscriptions" ADD COLUMN "price_change_notice" JSONB;
ALTER TABLE "tenant_subscriptions" ADD COLUMN "price_change_notice_dismissed_at" TIMESTAMP(3);
