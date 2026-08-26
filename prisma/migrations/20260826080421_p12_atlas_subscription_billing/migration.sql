-- CreateEnum
CREATE TYPE "checkout_target_type" AS ENUM ('plan_subscription', 'add_on');

-- CreateEnum
CREATE TYPE "checkout_status" AS ENUM ('draft', 'pending_payment', 'completed', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "payment_method_type" AS ENUM ('manual_bank_transfer', 'manual_wallet_transfer', 'gateway');

-- CreateEnum
CREATE TYPE "payment_lifecycle_status" AS ENUM ('created', 'pending', 'processing', 'requires_action', 'requires_confirmation', 'succeeded', 'failed', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "manual_review_status" AS ENUM ('not_required', 'pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "payment_attempt_status" AS ENUM ('initiated', 'processing', 'failed', 'succeeded', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('draft', 'issued', 'paid', 'void');

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" "payment_method_type" NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "provider" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL,
    "manual_instructions" JSONB,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkouts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "target_type" "checkout_target_type" NOT NULL,
    "target_key" TEXT NOT NULL,
    "billing_cycle" "subscription_billing_cycle",
    "snapshot" JSONB NOT NULL,
    "status" "checkout_status" NOT NULL DEFAULT 'draft',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "checkout_id" TEXT,
    "organization_id" TEXT NOT NULL,
    "method_key" TEXT NOT NULL,
    "method_type" "payment_method_type" NOT NULL,
    "provider" TEXT NOT NULL,
    "amount_minor_units" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "payment_lifecycle_status" NOT NULL DEFAULT 'created',
    "review_status" "manual_review_status" NOT NULL DEFAULT 'not_required',
    "failure_reason" TEXT,
    "review_notes" TEXT,
    "next_action" JSONB,
    "provider_reference" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "status" "payment_attempt_status" NOT NULL,
    "provider_reference" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_proofs" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "note" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_reviews" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "status" "manual_review_status" NOT NULL,
    "reviewed_by" TEXT NOT NULL,
    "notes" TEXT,
    "reviewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_invoices" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "payment_id" TEXT,
    "number" TEXT NOT NULL,
    "status" "invoice_status" NOT NULL DEFAULT 'draft',
    "amount_minor_units" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3),
    "due_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_key_key" ON "payment_methods"("key");

-- CreateIndex
CREATE INDEX "checkouts_organization_id_idx" ON "checkouts"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "checkouts_organization_id_idempotency_key_key" ON "checkouts"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "payments_organization_id_idx" ON "payments"("organization_id");

-- CreateIndex
CREATE INDEX "payments_checkout_id_idx" ON "payments"("checkout_id");

-- CreateIndex
CREATE INDEX "payment_attempts_payment_id_idx" ON "payment_attempts"("payment_id");

-- CreateIndex
CREATE INDEX "payment_proofs_payment_id_idx" ON "payment_proofs"("payment_id");

-- CreateIndex
CREATE INDEX "payment_reviews_payment_id_idx" ON "payment_reviews"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_invoices_number_key" ON "tenant_invoices"("number");

-- CreateIndex
CREATE INDEX "tenant_invoices_organization_id_idx" ON "tenant_invoices"("organization_id");

-- CreateIndex
CREATE INDEX "payment_webhook_events_organization_id_idx" ON "payment_webhook_events"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_events_provider_event_id_key" ON "payment_webhook_events"("provider", "event_id");

-- AddForeignKey
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_checkout_id_fkey" FOREIGN KEY ("checkout_id") REFERENCES "checkouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_reviews" ADD CONSTRAINT "payment_reviews_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_reviews" ADD CONSTRAINT "payment_reviews_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_invoices" ADD CONSTRAINT "tenant_invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_invoices" ADD CONSTRAINT "tenant_invoices_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security (master plan §7, §17: "a table must never exist, even
-- briefly, without its RLS policy in the same deploy").
--
-- `payment_methods` is a PLATFORM-owned catalog table (exactly like
-- `plans`/`add_ons`/`trial_policy`, P4's own precedent) — no
-- `organization_id`/`academy_id`, no RLS policy at all: every authenticated
-- caller reads the same catalog (`PaymentService.getPaymentMethods`'s own
-- doc comment: "Not organization-scoped").
--
-- `checkouts` / `payments` / `payment_attempts` / `payment_proofs` /
-- `payment_reviews` / `tenant_invoices` / `payment_webhook_events` are all
-- organization-scoped and reuse the exact P2 session variable
-- (`app.current_organization_id`, via `TenancyContextService.
-- runInTenantContext`) for every Tenant-initiated read/write — no new
-- tenant mechanism. `payment_attempts`/`payment_proofs`/`payment_reviews`
-- carry no `organization_id` column of their own; their policies reach
-- `organization_id` transitively through `payment_id → payments`, the same
-- one-directional child→parent subquery shape P6 already established for
-- `course_progress`/`lesson_progress` → `enrollments` (never circular —
-- `payments`'s own policies never reference these child tables back, so
-- Postgres's "infinite recursion detected in policy" failure mode P7's own
-- migration documents does not apply here).
--
-- Two NEW, narrow, explicit exceptions this phase introduces — the same
-- "documented, purpose-built, never a blanket bypass" discipline P7's
-- `is_course_instructor`/`is_academy_member` and P11's
-- `resolve_public_hostname`/`resolve_academy_organization` already
-- established:
--
--   1. `resolve_payment_organization(payment_id)` — a `SECURITY DEFINER`
--      function, owned by the migration role, that resolves a Payment's
--      `organization_id` with NO session variable set at all. This is the
--      one step in the whole system that legitimately runs before any
--      tenant context exists: an inbound payment-provider webhook carries
--      only a bare payment id, not a session — `PaymentWebhookService`
--      calls this function first, then opens a completely ordinary
--      `runInTenantContext(organizationId, ...)` for every subsequent
--      query in that request, exactly mirroring how P11's
--      `resolve_academy_organization` unlocks a legitimate tenant context
--      for the public website runtime. It is never used to bypass RLS for
--      anything beyond this one id→id lookup.
--
--   2. `is_platform_owner(user_id)` — a `SECURITY DEFINER` function reading
--      the real `users.is_platform_owner` column (the same source of truth
--      `PlatformOwnerGuard` itself re-reads on every request, master plan
--      §9: "no permission string can imply the Platform Owner role").
--      Paired with the P2-established `app.current_user_id` session
--      variable (`TenancyContextService.runInUserContext`, already used by
--      `OrganizationsService`/`UserOrganizationsService` for "which
--      organizations does this user belong to") to grant
--      `PlatformPaymentService`'s flat, cross-tenant `/payments` review
--      surface — required by master plan §10's own table ("Payments
--      (Platform review) | /payments (flat) | role") — real SELECT/UPDATE
--      access to exactly the four payment tables platform review touches,
--      and nothing else. `OrganizationMembershipGuard`-gated Tenant routes
--      never call `runInUserContext`; `PlatformOwnerGuard`-gated routes
--      never call `runInTenantContext` — the two session variables are
--      never set together in the same transaction, so a caller who is
--      merely an organization member (not a platform owner) can never
--      incidentally satisfy the platform-review policies, and vice versa.
--
-- Command coverage, deliberate, mirroring P4/P6/P7's own established
-- reasoning table-by-table:
--   SELECT — tenant-scoped on every table; platform-review-scoped
--     additionally on `payments`/`payment_attempts`/`payment_proofs`/
--     `payment_reviews` (the four tables `PlatformPaymentReviewListPage`/
--     `PlatformPaymentReviewDetailPage` actually read).
--   INSERT — narrow (`WITH CHECK` pinned to the active tenant context or
--     `is_platform_owner`), never `WITH CHECK (true)` (the P2-established
--     anti-pattern), on every table, including `tenant_invoices` even
--     though NO endpoint in P12 creates a row there (mirrors P4's
--     `tenant_subscriptions`/`tenant_add_ons` precedent exactly: "the
--     policy governs the `atlas_app` role itself, not which endpoints
--     currently call it, so it lands the moment the table exists").
--   UPDATE — `checkouts` (status transitions as a Payment against it
--     progresses), `payments` (tenant: `cancelPayment`/proof-submission
--     status change; platform-review: approve/reject), `payment_attempts`
--     (tenant: attempt status transitions). No UPDATE anywhere else —
--     `payment_proofs`/`payment_reviews`/`tenant_invoices`/
--     `payment_webhook_events` are all append-only by design (a proof
--     resubmission or a second review is a new row, never a mutation of
--     the first).
--   DELETE — none on any table, none planned (matches every prior phase).
--
-- Additive change to a P4 table: `tenant_subscriptions` gains its first-
-- ever UPDATE policy here — P4 shipped none because nothing wrote to that
-- table yet ("No UPDATE policy on `tenant_subscriptions`/`tenant_add_ons`
-- — no endpoint updates either," P4 migration's own comment). P12 is the
-- first phase with a real writer (a successful Payment updates the
-- Tenant's subscription), so this is the exact "additive, narrow,
-- non-invented RLS change to unblock a real new writer" case P4's own
-- comment anticipated. `tenant_add_ons` needs no new policy — its existing
-- P4 INSERT policy already covers add-on activation.
-- ============================================================================

CREATE FUNCTION resolve_payment_organization(p_payment_id text)
RETURNS TABLE(organization_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p."organization_id" FROM "payments" p WHERE p."id" = p_payment_id;
$$;

CREATE FUNCTION is_platform_owner(p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT "is_platform_owner" FROM "users" WHERE "id" = p_user_id), false);
$$;

-- ---------------------------------------------------------------------------
-- checkouts
-- ---------------------------------------------------------------------------

ALTER TABLE "checkouts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "checkouts" FORCE ROW LEVEL SECURITY;

CREATE POLICY "checkouts_tenant_select" ON "checkouts"
  FOR SELECT
  USING ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "checkouts_tenant_insert" ON "checkouts"
  FOR INSERT
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "checkouts_tenant_update" ON "checkouts"
  FOR UPDATE
  USING ("organization_id"::text = current_setting('app.current_organization_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------

ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;

CREATE POLICY "payments_tenant_select" ON "payments"
  FOR SELECT
  USING ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "payments_platform_review_select" ON "payments"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "payments_tenant_insert" ON "payments"
  FOR INSERT
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "payments_tenant_update" ON "payments"
  FOR UPDATE
  USING ("organization_id"::text = current_setting('app.current_organization_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "payments_platform_review_update" ON "payments"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

-- ---------------------------------------------------------------------------
-- payment_attempts (transitive via payments.organization_id)
-- ---------------------------------------------------------------------------

ALTER TABLE "payment_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_attempts" FORCE ROW LEVEL SECURITY;

CREATE POLICY "payment_attempts_tenant_select" ON "payment_attempts"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "payments" p
      WHERE p."id" = "payment_attempts"."payment_id"
        AND p."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "payment_attempts_platform_review_select" ON "payment_attempts"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "payment_attempts_tenant_insert" ON "payment_attempts"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "payments" p
      WHERE p."id" = "payment_attempts"."payment_id"
        AND p."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "payment_attempts_tenant_update" ON "payment_attempts"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "payments" p
      WHERE p."id" = "payment_attempts"."payment_id"
        AND p."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "payments" p
      WHERE p."id" = "payment_attempts"."payment_id"
        AND p."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

-- ---------------------------------------------------------------------------
-- payment_proofs (transitive via payments.organization_id)
-- ---------------------------------------------------------------------------

ALTER TABLE "payment_proofs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_proofs" FORCE ROW LEVEL SECURITY;

CREATE POLICY "payment_proofs_tenant_select" ON "payment_proofs"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "payments" p
      WHERE p."id" = "payment_proofs"."payment_id"
        AND p."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "payment_proofs_platform_review_select" ON "payment_proofs"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "payment_proofs_tenant_insert" ON "payment_proofs"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "payments" p
      WHERE p."id" = "payment_proofs"."payment_id"
        AND p."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

-- ---------------------------------------------------------------------------
-- payment_reviews (transitive via payments.organization_id)
-- ---------------------------------------------------------------------------

ALTER TABLE "payment_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_reviews" FORCE ROW LEVEL SECURITY;

CREATE POLICY "payment_reviews_tenant_select" ON "payment_reviews"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "payments" p
      WHERE p."id" = "payment_reviews"."payment_id"
        AND p."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "payment_reviews_platform_review_select" ON "payment_reviews"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "payment_reviews_platform_review_insert" ON "payment_reviews"
  FOR INSERT
  WITH CHECK (
    is_platform_owner(current_setting('app.current_user_id', true))
    AND "reviewed_by"::text = current_setting('app.current_user_id', true)
  );

-- ---------------------------------------------------------------------------
-- tenant_invoices
-- ---------------------------------------------------------------------------

ALTER TABLE "tenant_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_invoices" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_invoices_tenant_select" ON "tenant_invoices"
  FOR SELECT
  USING ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "tenant_invoices_tenant_insert" ON "tenant_invoices"
  FOR INSERT
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));

-- ---------------------------------------------------------------------------
-- payment_webhook_events
-- ---------------------------------------------------------------------------

ALTER TABLE "payment_webhook_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_webhook_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY "payment_webhook_events_tenant_select" ON "payment_webhook_events"
  FOR SELECT
  USING ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "payment_webhook_events_tenant_insert" ON "payment_webhook_events"
  FOR INSERT
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));

-- ---------------------------------------------------------------------------
-- tenant_subscriptions (P4 table) — additive UPDATE policy, see header
-- comment above. `tenant_add_ons` needs no new policy (existing P4 INSERT
-- policy already covers add-on activation).
-- ---------------------------------------------------------------------------

CREATE POLICY "tenant_subscriptions_tenant_update" ON "tenant_subscriptions"
  FOR UPDATE
  USING ("organization_id"::text = current_setting('app.current_organization_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));
