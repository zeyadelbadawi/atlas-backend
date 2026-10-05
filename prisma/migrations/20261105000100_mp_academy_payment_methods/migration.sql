-- ============================================================================
-- Academy Manual Payments (MP) — 2/2: per-academy manual methods and the
-- Client Owner's review path.
--
-- ADDITIVE ONLY. One new, empty table; three new NULLABLE columns; two new
-- SECURITY DEFINER helpers; new policies that admit ONLY rows of the new
-- `academy_manual` provider. No existing row is read, rewritten or
-- backfilled, and no existing policy is changed: every academy without an
-- enabled method behaves exactly as before, and the existing guarantee that
-- an organization's tenant context cannot change an Atlas-collected
-- (`atlas_manual`) order or payment still holds — the new UPDATE policies
-- never match those rows.
--
-- 1. `academy_payment_methods` — the bank / InstaPay / wallet details ONE
--    academy accepts. At most one per type per academy; `gateway` refused.
--    RLS:
--      - tenant SELECT/INSERT/UPDATE: the row's organization is the current
--        organization, and on write the academy really belongs to it. WHO in
--        the organization may write is decided above RLS (Client Owner
--        only, `AcademyPaymentMethodsService`), like every tenant table.
--      - buyer SELECT: ENABLED rows only, to any signed-in user context. A
--        learner must read the details to pay; these are exactly the details
--        the academy publishes at checkout. Disabled rows stay invisible.
--      - no DELETE policy: a method is disabled, never deleted.
--
-- 2. `payments.academy_payment_method_id` — which academy method a payment
--    was taken with (SET NULL if the method row is ever removed with its
--    academy; the payment keeps its `instructions_snapshot`).
--    `payment_proofs.payer_reference` — the transfer reference the learner
--    typed. `provisioning_requests.requested_payment_methods` — the methods
--    chosen in the academy setup form, applied once the academy exists.
--
-- 3. Client Owner review. Course payments carry no `organization_id` (P13
--    CHECK), so the organization is resolved through the course order. Two
--    helpers do that with SECURITY DEFINER: policies on `course_orders`
--    that query `payments`, whose own tenant policy queries
--    `course_orders`, would otherwise be rejected by PostgreSQL as
--    recursive. Both return true only for an `academy_manual` payment.
--      - payments UPDATE (tenant): academy_manual rows of the current org.
--      - course_orders UPDATE (tenant): orders of the current org that have
--        an academy_manual payment (mark paid; reopen after a rejection).
--      - payment_proofs SELECT (tenant): proofs of those payments, so the
--        reviewer can see the file (still streamed by the API only).
--      - payment_reviews SELECT/INSERT (tenant): the decision row, written
--        only as the current user (`reviewed_by = app.current_user_id`).
--    `academy_organization_owner_recipients` returns the Client Owner's
--    user id for the "payment to review" notification, which is emitted
--    from the learner's own transaction.
--    Enrollment and academy-student writes on approval already have
--    tenant/staff policies (the owner's staff grant path uses them).
--
-- Recovery (no data depends on these objects until an academy enables a
-- method; drop in reverse order):
--   DROP POLICY "payment_reviews_tenant_academy_manual_insert" ON "payment_reviews";
--   DROP POLICY "payment_reviews_tenant_academy_manual_select" ON "payment_reviews";
--   DROP POLICY "payment_proofs_tenant_academy_manual_select" ON "payment_proofs";
--   DROP POLICY "course_orders_tenant_academy_manual_update" ON "course_orders";
--   DROP POLICY "payments_tenant_academy_manual_update" ON "payments";
--   DROP FUNCTION is_academy_manual_course_order(text, text);
--   DROP FUNCTION is_academy_manual_payment_of_organization(text, text);
--   DROP FUNCTION academy_organization_owner_recipients(text);
--   ALTER TABLE "payments" DROP COLUMN "academy_payment_method_id";
--   ALTER TABLE "payment_proofs" DROP COLUMN "payer_reference";
--   ALTER TABLE "provisioning_requests" DROP COLUMN "requested_payment_methods";
--   DROP TABLE "academy_payment_methods";
-- ============================================================================

-- AlterTable
ALTER TABLE "payment_proofs" ADD COLUMN "payer_reference" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "academy_payment_method_id" TEXT;

-- AlterTable
ALTER TABLE "provisioning_requests" ADD COLUMN "requested_payment_methods" JSONB;

-- CreateTable
CREATE TABLE "academy_payment_methods" (
    "id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "type" "payment_method_type" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "instructions" JSONB NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "academy_payment_methods_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "academy_payment_methods_manual_type_check"
      CHECK ("type" IN ('manual_bank_transfer', 'manual_wallet_transfer', 'manual_instapay')),
    CONSTRAINT "academy_payment_methods_instructions_object_check"
      CHECK (jsonb_typeof("instructions") = 'object')
);

-- CreateIndex
CREATE INDEX "academy_payment_methods_organization_id_idx" ON "academy_payment_methods"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "academy_payment_methods_academy_id_type_key" ON "academy_payment_methods"("academy_id", "type");

-- CreateIndex
CREATE INDEX "payments_academy_payment_method_id_idx" ON "payments"("academy_payment_method_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_academy_payment_method_id_fkey" FOREIGN KEY ("academy_payment_method_id") REFERENCES "academy_payment_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy_payment_methods" ADD CONSTRAINT "academy_payment_methods_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy_payment_methods" ADD CONSTRAINT "academy_payment_methods_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- RLS: academy_payment_methods
-- ---------------------------------------------------------------------------
ALTER TABLE "academy_payment_methods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "academy_payment_methods" FORCE ROW LEVEL SECURITY;

CREATE POLICY "academy_payment_methods_tenant_select" ON "academy_payment_methods"
  FOR SELECT
  USING ("organization_id" = current_setting('app.current_organization_id', true));

CREATE POLICY "academy_payment_methods_tenant_insert" ON "academy_payment_methods"
  FOR INSERT
  WITH CHECK (
    "organization_id" = current_setting('app.current_organization_id', true)
    AND EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "academy_payment_methods"."academy_id"
        AND a."organization_id" = "academy_payment_methods"."organization_id"
    )
  );

CREATE POLICY "academy_payment_methods_tenant_update" ON "academy_payment_methods"
  FOR UPDATE
  USING ("organization_id" = current_setting('app.current_organization_id', true))
  WITH CHECK (
    "organization_id" = current_setting('app.current_organization_id', true)
    AND EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "academy_payment_methods"."academy_id"
        AND a."organization_id" = "academy_payment_methods"."organization_id"
    )
  );

CREATE POLICY "academy_payment_methods_buyer_select" ON "academy_payment_methods"
  FOR SELECT
  USING (
    "enabled" = true
    AND COALESCE(current_setting('app.current_user_id', true), '') <> ''
  );

-- ---------------------------------------------------------------------------
-- Helpers: resolve an academy_manual course payment's organization.
-- ---------------------------------------------------------------------------
CREATE FUNCTION is_academy_manual_payment_of_organization(p_payment_id text, p_organization_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(p_organization_id, '') <> '' AND EXISTS (
    SELECT 1
    FROM "payments" p
    JOIN "course_orders" co ON co."id" = p."course_order_id"
    WHERE p."id" = p_payment_id
      AND p."provider" = 'academy_manual'
      AND co."organization_id" = p_organization_id
  );
$$;

REVOKE ALL ON FUNCTION is_academy_manual_payment_of_organization(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_academy_manual_payment_of_organization(text, text) TO "atlas_app";

CREATE FUNCTION is_academy_manual_course_order(p_course_order_id text, p_organization_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(p_organization_id, '') <> '' AND EXISTS (
    SELECT 1
    FROM "course_orders" co
    JOIN "payments" p ON p."course_order_id" = co."id"
    WHERE co."id" = p_course_order_id
      AND co."organization_id" = p_organization_id
      AND p."provider" = 'academy_manual'
  );
$$;

REVOKE ALL ON FUNCTION is_academy_manual_course_order(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_academy_manual_course_order(text, text) TO "atlas_app";

-- ---------------------------------------------------------------------------
-- Who is told that a learner submitted a payment for review: the Client
-- Owner (organization owner) of the academy's organization. Called from the
-- LEARNER's transaction, which can read neither the academy nor the
-- organization's memberships — same shape as
-- `academy_notification_recipients`: user ids only, nothing else.
-- ---------------------------------------------------------------------------
CREATE FUNCTION academy_organization_owner_recipients(p_academy_id text)
RETURNS TABLE (user_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT om."user_id"
  FROM "academies" a
  JOIN "organization_memberships" om ON om."organization_id" = a."organization_id"
  WHERE a."id" = p_academy_id
    AND om."role" = 'owner'
  ORDER BY om."user_id";
$$;

REVOKE ALL ON FUNCTION academy_organization_owner_recipients(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION academy_organization_owner_recipients(text) TO "atlas_app";

-- ---------------------------------------------------------------------------
-- Client Owner review policies (academy_manual rows only).
-- ---------------------------------------------------------------------------
CREATE POLICY "payments_tenant_academy_manual_update" ON "payments"
  FOR UPDATE
  USING (
    "provider" = 'academy_manual'
    AND is_academy_manual_payment_of_organization(
      "id", current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    "provider" = 'academy_manual'
    AND is_academy_manual_payment_of_organization(
      "id", current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "course_orders_tenant_academy_manual_update" ON "course_orders"
  FOR UPDATE
  USING (
    is_academy_manual_course_order(
      "id", current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    "organization_id" = current_setting('app.current_organization_id', true)
  );

CREATE POLICY "payment_proofs_tenant_academy_manual_select" ON "payment_proofs"
  FOR SELECT
  USING (
    is_academy_manual_payment_of_organization(
      "payment_id", current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "payment_reviews_tenant_academy_manual_select" ON "payment_reviews"
  FOR SELECT
  USING (
    is_academy_manual_payment_of_organization(
      "payment_id", current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "payment_reviews_tenant_academy_manual_insert" ON "payment_reviews"
  FOR INSERT
  WITH CHECK (
    "reviewed_by" = current_setting('app.current_user_id', true)
    AND is_academy_manual_payment_of_organization(
      "payment_id", current_setting('app.current_organization_id', true)
    )
  );
