-- Academy Orders (Task 4) — read-only organization visibility of the
-- organization's own course sales, plus the Platform Owner's read of
-- subscription checkouts for the payment review list.
--
-- THE GAP. Course Commerce (P13) made `course_orders`, the course-purchase
-- rows of `payments` and `course_order_refunds` readable by the BUYER
-- (`app.current_user_id`) and by a Platform Owner only. The organization
-- that sold the course had no read path at all, so an Organization Owner
-- could see the net revenue ledger (`revenue_ledger_entries_tenant_select`)
-- but never the orders behind it.
--
-- THE MODEL. SELECT only — no INSERT/UPDATE/DELETE policy is added, so the
-- organization still cannot create, edit or refund an order; every write
-- path keeps exactly the policies it had. Each new policy is keyed off
-- `app.current_organization_id`, the same session variable every other
-- tenant policy uses:
--
--   - `course_orders` carries a denormalized `organization_id` (written at
--     order creation from the academy), so the predicate is a direct
--     column comparison — the same shape as `checkouts_tenant_select`.
--   - a course-purchase `payments` row has `organization_id IS NULL` by
--     the P13 CHECK constraint (that column belongs to the subscription
--     flow), so it is resolved through its course order. The predicate
--     requires `course_order_id IS NOT NULL`, so a subscription row is never
--     admitted by this policy; those stay governed by
--     `payments_tenant_select` exactly as before.
--   - `course_order_refunds` is resolved through its course order too.
--
-- Who inside the organization may read these is decided above RLS, by the
-- service (`assertCanViewAcademyFinance`: Organization Owner only) — the
-- same split the academy payout and revenue ledger reads already use.
--
-- `payment_attempts`/`payment_proofs` deliberately get NO tenant policy for
-- course payments: proofs are private payer uploads and the academy orders
-- surface never reads them.
--
-- `checkouts_platform_select` mirrors the P15 `*_platform_select` set
-- (organizations, academies, courses, tenant_subscriptions): the Platform
-- Owner's payment review list shows which plan and billing cycle a
-- subscription payment is for, which lives on the checkout. Read only.

CREATE POLICY "course_orders_tenant_select" ON "course_orders"
  FOR SELECT
  USING ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "payments_tenant_course_order_select" ON "payments"
  FOR SELECT
  USING (
    "course_order_id" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "course_orders" co
      WHERE co."id" = "payments"."course_order_id"
        AND co."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "course_order_refunds_tenant_select" ON "course_order_refunds"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "course_orders" co
      WHERE co."id" = "course_order_refunds"."course_order_id"
        AND co."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "checkouts_platform_select" ON "checkouts"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));
