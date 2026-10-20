-- ============================================================================
-- course_order_refunds: narrow the INSERT policy to the two paths that
-- legitimately create a refund row.
--
-- THE GAP. P13's `course_order_refunds_buyer_insert` checked only
-- `requested_by = app.current_user_id`. Under the `atlas_app` runtime role
-- that let ANY signed-in user insert a refund row naming themselves for ANY
-- course order and payment — the service layer was the only thing stopping
-- it. RLS is the primary defense, not a backstop (same reasoning as
-- `20260823184500_p2_narrow_insert_rls_policies`).
--
-- THE WRITERS (every one, checked in code):
--
--   1. `CourseOrderRefundsService.requestRefund` — the learner's
--      self-service refund of an Atlas-collected course payment. Runs as the
--      learner (`runInTenantAndUserContext(order.organizationId,
--      studentId)`), `requested_by` = the learner. It refuses
--      `academy_manual` payments before inserting.
--   2. `AcademyCoursePaymentsService.recordRefund` — the Organization Owner
--      records that the ACADEMY refunded an `academy_manual` payment. Runs
--      as the owner in the order's tenant context
--      (`runInTenantAndUserContext(organizationId, ownerId)`),
--      `requested_by` = the owner.
--
-- Nothing else inserts (account deletion only re-points identifying data;
-- test fixtures use a superuser connection outside this role).
--
-- THE POLICIES (permissive, so a row must satisfy one of them):
--
--   course_order_refunds_buyer_insert — the learner, for their OWN order,
--     with their OWN payment that belongs to that order, and never for an
--     `academy_manual` payment (that money never passed through Atlas).
--     The EXISTS is subject to the buyer's own `course_orders`/`payments`
--     visibility, which is exactly "mine".
--
--   course_order_refunds_tenant_academy_manual_insert — the caller, in the
--     tenant context of the order's organization, for an `academy_manual`
--     payment of that organization that belongs to that order, and only
--     if the caller is an owner of the organization (resolved through the
--     existing SECURITY DEFINER `academy_organization_owner_recipients`,
--     as `requested_by` is the owner). Same shape as
--     `payment_reviews_tenant_academy_manual_insert`.
--
-- DROP/CREATE POLICY only: no table, column, data or function changes.
-- ============================================================================

DROP POLICY "course_order_refunds_buyer_insert" ON "course_order_refunds";

CREATE POLICY "course_order_refunds_buyer_insert" ON "course_order_refunds"
  FOR INSERT
  WITH CHECK (
    "requested_by"::text = current_setting('app.current_user_id', true)
    AND EXISTS (
      SELECT 1
      FROM "course_orders" co
      JOIN "payments" p ON p."course_order_id" = co."id"
      WHERE co."id" = "course_order_refunds"."course_order_id"
        AND p."id" = "course_order_refunds"."payment_id"
        AND co."student_id"::text = current_setting('app.current_user_id', true)
        AND p."payer_user_id"::text = current_setting('app.current_user_id', true)
        AND p."provider" <> 'academy_manual'
    )
  );

CREATE POLICY "course_order_refunds_tenant_academy_manual_insert" ON "course_order_refunds"
  FOR INSERT
  WITH CHECK (
    "requested_by"::text = current_setting('app.current_user_id', true)
    AND is_academy_manual_payment_of_organization(
      "payment_id", current_setting('app.current_organization_id', true)
    )
    AND EXISTS (
      SELECT 1
      FROM "course_orders" co
      JOIN "payments" p ON p."course_order_id" = co."id"
      WHERE co."id" = "course_order_refunds"."course_order_id"
        AND p."id" = "course_order_refunds"."payment_id"
        AND co."organization_id" = current_setting('app.current_organization_id', true)
        AND current_setting('app.current_user_id', true) IN (
          SELECT r."user_id" FROM academy_organization_owner_recipients(co."academy_id") r
        )
    )
  );
