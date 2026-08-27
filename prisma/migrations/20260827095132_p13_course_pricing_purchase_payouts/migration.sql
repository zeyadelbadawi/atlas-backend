-- CreateEnum
CREATE TYPE "course_order_status" AS ENUM ('draft', 'pending_payment', 'paid', 'expired', 'cancelled', 'refunded');

-- CreateEnum
CREATE TYPE "revenue_ledger_entry_type" AS ENUM ('sale', 'platform_fee', 'refund', 'commission_reversal', 'payout');

-- CreateEnum
CREATE TYPE "academy_payout_status" AS ENUM ('pending', 'processing', 'paid', 'failed');

-- CreateEnum
CREATE TYPE "course_order_refund_type" AS ENUM ('full');

-- CreateEnum
CREATE TYPE "course_order_refund_status" AS ENUM ('pending', 'succeeded', 'failed');

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "commission_amount_minor_units" BIGINT,
ADD COLUMN     "commission_rate_basis_points_snapshot" INTEGER,
ADD COLUMN     "course_order_id" TEXT,
ADD COLUMN     "payee_academy_id" TEXT,
ADD COLUMN     "payer_user_id" TEXT,
ADD COLUMN     "payment_collection_mode_snapshot" "payment_collection_mode",
ALTER COLUMN "organization_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "plan_commission_settings" (
    "plan_id" TEXT NOT NULL,
    "commission_basis_points" INTEGER NOT NULL,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_commission_settings_pkey" PRIMARY KEY ("plan_id")
);

-- CreateTable
CREATE TABLE "course_orders" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "status" "course_order_status" NOT NULL DEFAULT 'draft',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "course_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_ledger_entries" (
    "id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "course_order_id" TEXT NOT NULL,
    "payment_id" TEXT,
    "entry_type" "revenue_ledger_entry_type" NOT NULL,
    "amount_minor_units" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academy_payouts" (
    "id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "status" "academy_payout_status" NOT NULL DEFAULT 'pending',
    "amount_minor_units" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),
    "provider_reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "academy_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academy_payout_items" (
    "id" TEXT NOT NULL,
    "payout_id" TEXT NOT NULL,
    "revenue_ledger_entry_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academy_payout_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_order_refunds" (
    "id" TEXT NOT NULL,
    "course_order_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "refund_type" "course_order_refund_type" NOT NULL DEFAULT 'full',
    "status" "course_order_refund_status" NOT NULL DEFAULT 'succeeded',
    "amount_minor_units" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT,
    "requested_by" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "course_order_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "course_orders_student_id_status_idx" ON "course_orders"("student_id", "status");

-- CreateIndex
CREATE INDEX "course_orders_course_id_idx" ON "course_orders"("course_id");

-- CreateIndex
CREATE INDEX "course_orders_academy_id_idx" ON "course_orders"("academy_id");

-- CreateIndex
CREATE UNIQUE INDEX "course_orders_student_id_idempotency_key_key" ON "course_orders"("student_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "revenue_ledger_entries_academy_id_occurred_at_idx" ON "revenue_ledger_entries"("academy_id", "occurred_at");

-- CreateIndex
CREATE INDEX "revenue_ledger_entries_course_order_id_idx" ON "revenue_ledger_entries"("course_order_id");

-- CreateIndex
CREATE INDEX "academy_payouts_academy_id_status_idx" ON "academy_payouts"("academy_id", "status");

-- CreateIndex
CREATE INDEX "academy_payout_items_payout_id_idx" ON "academy_payout_items"("payout_id");

-- CreateIndex
CREATE UNIQUE INDEX "academy_payout_items_revenue_ledger_entry_id_key" ON "academy_payout_items"("revenue_ledger_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "course_order_refunds_course_order_id_key" ON "course_order_refunds"("course_order_id");

-- CreateIndex
CREATE INDEX "payments_payer_user_id_idx" ON "payments"("payer_user_id");

-- CreateIndex
CREATE INDEX "payments_course_order_id_idx" ON "payments"("course_order_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_payer_user_id_fkey" FOREIGN KEY ("payer_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_payee_academy_id_fkey" FOREIGN KEY ("payee_academy_id") REFERENCES "academies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_course_order_id_fkey" FOREIGN KEY ("course_order_id") REFERENCES "course_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_commission_settings" ADD CONSTRAINT "plan_commission_settings_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_commission_settings" ADD CONSTRAINT "plan_commission_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_orders" ADD CONSTRAINT "course_orders_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_orders" ADD CONSTRAINT "course_orders_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_orders" ADD CONSTRAINT "course_orders_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_orders" ADD CONSTRAINT "course_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_ledger_entries" ADD CONSTRAINT "revenue_ledger_entries_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_ledger_entries" ADD CONSTRAINT "revenue_ledger_entries_course_order_id_fkey" FOREIGN KEY ("course_order_id") REFERENCES "course_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_ledger_entries" ADD CONSTRAINT "revenue_ledger_entries_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy_payouts" ADD CONSTRAINT "academy_payouts_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy_payout_items" ADD CONSTRAINT "academy_payout_items_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "academy_payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy_payout_items" ADD CONSTRAINT "academy_payout_items_revenue_ledger_entry_id_fkey" FOREIGN KEY ("revenue_ledger_entry_id") REFERENCES "revenue_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_order_refunds" ADD CONSTRAINT "course_order_refunds_course_order_id_fkey" FOREIGN KEY ("course_order_id") REFERENCES "course_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_order_refunds" ADD CONSTRAINT "course_order_refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_order_refunds" ADD CONSTRAINT "course_order_refunds_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- CHECK constraint — `payments` now serves two structurally distinct money
-- flows on one table (ADR-010, master plan §5.7's own documented extension
-- point). Exactly one of `(organization_id)` or `(payer_user_id AND
-- payee_academy_id)` must be populated per row — never both, never
-- neither. Prisma's schema language has no CHECK-constraint syntax, so
-- this is appended by hand, same convention as every RLS policy below.
-- ============================================================================

ALTER TABLE "payments" ADD CONSTRAINT "payments_org_xor_course_order_payer_chk" CHECK (
  ("organization_id" IS NOT NULL AND "payer_user_id" IS NULL AND "payee_academy_id" IS NULL)
  OR
  ("organization_id" IS NULL AND "payer_user_id" IS NOT NULL AND "payee_academy_id" IS NOT NULL)
);

-- ============================================================================
-- Row-Level Security (master plan §7, §17: "a table must never exist, even
-- briefly, without its RLS policy in the same deploy").
--
-- `plan_commission_settings` — platform-owned catalog-adjacent
-- configuration (mirrors `atlas_commission_config`'s exact precedent): no
-- RLS at all. Write access is `PlatformOwnerGuard`-gated at the
-- application/controller layer only (`PlatformCommissionController`),
-- matching `atlas_commission_config`'s own identical "platform-
-- infrastructure table, no tenant RLS, write-gated at the application
-- layer" category — see the P12 migration's header comment for why that
-- category needs no RLS at all (every authenticated caller may read the
-- same catalog-shaped data; only Platform Owner write matters, and no
-- tenant role can reach the write endpoint regardless of RLS).
--
-- One function CHANGE, no new function: `resolve_payment_organization`
-- (P12) is updated, `CREATE OR REPLACE` (additive, not a new grant), to
-- also resolve a course-order Payment's organization transitively through
-- `course_orders.organization_id` when `payments.organization_id` is now
-- null — see schema.prisma's own P13 header comment for the full
-- reasoning. Every other predicate below reuses an EXISTING mechanism
-- (`app.current_organization_id` since P2, `app.current_user_id` since
-- P6, `is_platform_owner()` since P12) — no new session variable, no new
-- tenancy model, matching this phase's explicit instruction verbatim.
--
-- `course_orders` — User-scoped (buyer), exactly like `enrollments` (P6):
-- SELECT/INSERT/UPDATE keyed on `student_id = app.current_user_id`, plus
-- a `is_platform_owner()` SELECT for the Platform course-order-payment
-- review surface (`PlatformCourseOrderPaymentsController`). No academy-
-- staff/organization-member policy — no product-specified surface for an
-- Academy to browse a student's individual orders exists in this phase
-- (Academy Revenue reporting reads `revenue_ledger_entries` instead, which
-- the Academy already may see — see below); adding one now would be
-- inventing scope this phase's own instructions warn against.
--
-- `payments` (P12 table, additive policies only) — gains a THIRD access
-- path alongside the existing tenant-organization and platform-review
-- policies: `payer_user_id = app.current_user_id`, covering every
-- course-order Payment row exactly the way `payments_tenant_select`/
-- `_insert`/`_update` already cover every organization-billing row. The
-- existing `payments_tenant_*` policies are untouched — a NULL
-- `organization_id` makes their `= current_setting(...)` comparison
-- evaluate to NULL (never TRUE), so a course-order Payment is correctly
-- invisible through the organization-scoped path, exactly as intended,
-- with zero change to those policies' text.
--
-- `revenue_ledger_entries` — append-only (master plan §5.8's explicit
-- "never mutated in place" rule): SELECT/INSERT only, no UPDATE/DELETE
-- policy at all, matching `payment_reviews`/`payment_webhook_events`'s
-- (P12) identical "structurally impossible to mutate" precedent. SELECT is
-- both transitively organization-scoped (Academy staff — "Academy Revenue
-- reporting," §5.8's own words, needs to read this) and
-- `is_platform_owner()`-scoped (payout computation, cross-tenant). INSERT
-- is transitively organization-scoped only — a ledger row is written
-- exclusively inside `runInTenantAndUserContext(courseOrder.organizationId,
-- courseOrder.studentId, ...)` by `CourseOrderPaymentApplicationService`/
-- `CourseOrderRefundsService`, so the active `app.current_organization_id`
-- is always the selling Academy's real Organization at the moment of
-- insert — never a Platform-Owner-only INSERT path, since nothing in this
-- phase writes a ledger row outside that one transaction shape.
--
-- `academy_payouts`/`academy_payout_items` — the ASYMMETRIC read/write
-- shape `organization_commission_settings` (P12.5) already established:
-- Academy staff (transitively organization-scoped) and Platform Owner both
-- get real SELECT; ONLY `is_platform_owner()` gets INSERT/UPDATE — an
-- Organization can see its own payouts but can never create or edit one,
-- matching this phase's explicit "payout execution is a job/Platform-
-- Owner action, never a Tenant-triggered endpoint" instruction.
--
-- `course_order_refunds` — buyer-scoped (`requested_by =
-- app.current_user_id`) SELECT/INSERT, plus `is_platform_owner()` SELECT
-- for support/audit visibility. No UPDATE policy at all — append-only,
-- same discipline as `revenue_ledger_entries` above (a refund row, once
-- written, is never edited; a hypothetical future async-gateway-refund
-- state transition would be a new column write pattern to design
-- explicitly then, not implicitly enabled now).
-- ============================================================================

CREATE OR REPLACE FUNCTION resolve_payment_organization(p_payment_id text)
RETURNS TABLE(organization_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(p."organization_id", co."organization_id")
  FROM "payments" p
  LEFT JOIN "course_orders" co ON co."id" = p."course_order_id"
  WHERE p."id" = p_payment_id;
$$;

-- ---------------------------------------------------------------------------
-- payments — additive payer-scoped policies (Course Commerce rows)
-- ---------------------------------------------------------------------------

CREATE POLICY "payments_payer_select" ON "payments"
  FOR SELECT
  USING ("payer_user_id"::text = current_setting('app.current_user_id', true));

CREATE POLICY "payments_payer_insert" ON "payments"
  FOR INSERT
  WITH CHECK ("payer_user_id"::text = current_setting('app.current_user_id', true));

CREATE POLICY "payments_payer_update" ON "payments"
  FOR UPDATE
  USING ("payer_user_id"::text = current_setting('app.current_user_id', true))
  WITH CHECK ("payer_user_id"::text = current_setting('app.current_user_id', true));

-- ---------------------------------------------------------------------------
-- course_orders
-- ---------------------------------------------------------------------------

ALTER TABLE "course_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "course_orders" FORCE ROW LEVEL SECURITY;

CREATE POLICY "course_orders_buyer_select" ON "course_orders"
  FOR SELECT
  USING ("student_id"::text = current_setting('app.current_user_id', true));

CREATE POLICY "course_orders_platform_select" ON "course_orders"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "course_orders_buyer_insert" ON "course_orders"
  FOR INSERT
  WITH CHECK ("student_id"::text = current_setting('app.current_user_id', true));

CREATE POLICY "course_orders_buyer_update" ON "course_orders"
  FOR UPDATE
  USING ("student_id"::text = current_setting('app.current_user_id', true))
  WITH CHECK ("student_id"::text = current_setting('app.current_user_id', true));

-- ---------------------------------------------------------------------------
-- revenue_ledger_entries (transitive via academies.organization_id)
-- ---------------------------------------------------------------------------

ALTER TABLE "revenue_ledger_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "revenue_ledger_entries" FORCE ROW LEVEL SECURITY;

CREATE POLICY "revenue_ledger_entries_tenant_select" ON "revenue_ledger_entries"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "revenue_ledger_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "revenue_ledger_entries_platform_select" ON "revenue_ledger_entries"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "revenue_ledger_entries_tenant_insert" ON "revenue_ledger_entries"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "revenue_ledger_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

-- ---------------------------------------------------------------------------
-- academy_payouts (transitive via academies.organization_id)
-- ---------------------------------------------------------------------------

ALTER TABLE "academy_payouts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "academy_payouts" FORCE ROW LEVEL SECURITY;

CREATE POLICY "academy_payouts_tenant_select" ON "academy_payouts"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "academy_payouts"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "academy_payouts_platform_select" ON "academy_payouts"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "academy_payouts_platform_insert" ON "academy_payouts"
  FOR INSERT
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "academy_payouts_platform_update" ON "academy_payouts"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

-- ---------------------------------------------------------------------------
-- academy_payout_items (transitive via payout_id -> academy_payouts)
-- ---------------------------------------------------------------------------

ALTER TABLE "academy_payout_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "academy_payout_items" FORCE ROW LEVEL SECURITY;

CREATE POLICY "academy_payout_items_tenant_select" ON "academy_payout_items"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academy_payouts" p
      JOIN "academies" a ON a."id" = p."academy_id"
      WHERE p."id" = "academy_payout_items"."payout_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "academy_payout_items_platform_select" ON "academy_payout_items"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "academy_payout_items_platform_insert" ON "academy_payout_items"
  FOR INSERT
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

-- ---------------------------------------------------------------------------
-- course_order_refunds
-- ---------------------------------------------------------------------------

ALTER TABLE "course_order_refunds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "course_order_refunds" FORCE ROW LEVEL SECURITY;

CREATE POLICY "course_order_refunds_buyer_select" ON "course_order_refunds"
  FOR SELECT
  USING ("requested_by"::text = current_setting('app.current_user_id', true));

CREATE POLICY "course_order_refunds_platform_select" ON "course_order_refunds"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "course_order_refunds_buyer_insert" ON "course_order_refunds"
  FOR INSERT
  WITH CHECK ("requested_by"::text = current_setting('app.current_user_id', true));

-- plan_commission_settings: platform-owned, no RLS — see header comment.
