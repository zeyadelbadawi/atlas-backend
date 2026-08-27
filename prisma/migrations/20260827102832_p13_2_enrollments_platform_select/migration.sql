-- ============================================================================
-- Phase P13 — a second, narrow RLS fix discovered alongside p13_1: the
-- same Platform-Owner-context transaction
-- (`CourseOrderPaymentApplicationService.applySuccessfulPayment`) reads
-- `enrollments` (to decide "create a new Enrollment" vs. "re-unlock an
-- existing, previously-refunded one") before deciding whether to write —
-- with no SELECT policy for `is_platform_owner()`, that read silently
-- returns nothing even when a row exists, so a repurchase-after-refund
-- would incorrectly attempt a second INSERT and fail the
-- `(student_id, course_id)` unique constraint. Additive, narrow, same
-- `is_platform_owner()` predicate as every other Platform-Owner policy in
-- this codebase — never a blanket bypass.
-- ============================================================================

CREATE POLICY "enrollments_platform_select" ON "enrollments"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));
