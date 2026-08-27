-- ============================================================================
-- Phase P13 — RLS fixes discovered during implementation (additive only;
-- no schema/table change, no `prisma/schema.prisma` diff — this migration
-- is RLS policy statements alone, the exact "Prisma's schema language has
-- no RLS syntax" precedent every prior phase's RLS block already follows).
--
-- Root cause: `PlatformCourseOrderPaymentsService.approvePayment`/
-- `rejectPayment` must run its whole atomic transaction under the
-- reviewing Platform Owner's own `app.current_user_id` — never the
-- buyer's — because `payment_reviews`'s existing P12 RLS policy requires
-- `reviewed_by = app.current_user_id AND is_platform_owner(...)`. That
-- same transaction also writes `course_orders` (status → paid) and
-- `enrollments` (create/re-unlock on purchase) as part of applying a
-- successful course-order payment (`CourseOrderPaymentApplicationService`)
-- — both of those tables' RLS was, until this migration, STUDENT-scoped
-- only (`course_orders_buyer_update`, `enrollments_self_insert`/
-- `_update`), with no path for a verified Platform Owner to perform this
-- narrow, legitimate, audited write. This migration adds exactly that
-- path — the same `is_platform_owner()`-gated, narrow-write pattern
-- P12's `payments_platform_review_update` already established — never a
-- blanket bypass.
--
-- Second root cause: `payment_attempts`/`payment_proofs` (written by a
-- buying student under `runInUserContext(studentId)` via
-- `CourseOrderPaymentsService.createPayment`/`submitProof`) only had a
-- transitive `payments.organization_id = app.current_organization_id`
-- SELECT/INSERT policy (P12) — structurally unsatisfiable for a
-- course-order Payment, whose `organization_id` is NULL by design (§5.7's
-- extension point). This migration adds the transitive
-- `payments.payer_user_id = app.current_user_id` analog, mirroring the
-- `payments_payer_select`/`_insert` policies the original P13 migration
-- already added directly on `payments` itself.
--
-- No new `SECURITY DEFINER` function, no new session variable — every
-- predicate below reuses `is_platform_owner()` (P12) or
-- `app.current_user_id` (P2/P6), exactly like every other RLS migration
-- in this codebase.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- course_orders — additive Platform-Owner UPDATE path
-- ---------------------------------------------------------------------------

CREATE POLICY "course_orders_platform_update" ON "course_orders"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

-- ---------------------------------------------------------------------------
-- enrollments (P6 table) — additive Platform-Owner INSERT/UPDATE path,
-- needed for course-order-payment-triggered enrollment creation/re-unlock.
-- No SELECT policy added — `PlatformCourseOrderPaymentsService` never
-- needs to READ an Enrollment, only create/update one as a side effect of
-- applying a successful Payment.
-- ---------------------------------------------------------------------------

CREATE POLICY "enrollments_platform_insert" ON "enrollments"
  FOR INSERT
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "enrollments_platform_update" ON "enrollments"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

-- ---------------------------------------------------------------------------
-- payment_attempts (P12 table) — additive payer-scoped path (transitive
-- via payments.payer_user_id), mirroring the org-scoped policy already
-- there.
-- ---------------------------------------------------------------------------

CREATE POLICY "payment_attempts_payer_select" ON "payment_attempts"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "payments" p
      WHERE p."id" = "payment_attempts"."payment_id"
        AND p."payer_user_id"::text = current_setting('app.current_user_id', true)
    )
  );

CREATE POLICY "payment_attempts_payer_insert" ON "payment_attempts"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "payments" p
      WHERE p."id" = "payment_attempts"."payment_id"
        AND p."payer_user_id"::text = current_setting('app.current_user_id', true)
    )
  );

-- ---------------------------------------------------------------------------
-- payment_proofs (P12 table) — additive payer-scoped path (transitive via
-- payments.payer_user_id), mirroring the org-scoped policy already there.
-- ---------------------------------------------------------------------------

CREATE POLICY "payment_proofs_payer_select" ON "payment_proofs"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "payments" p
      WHERE p."id" = "payment_proofs"."payment_id"
        AND p."payer_user_id"::text = current_setting('app.current_user_id', true)
    )
  );

CREATE POLICY "payment_proofs_payer_insert" ON "payment_proofs"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "payments" p
      WHERE p."id" = "payment_proofs"."payment_id"
        AND p."payer_user_id"::text = current_setting('app.current_user_id', true)
    )
  );
