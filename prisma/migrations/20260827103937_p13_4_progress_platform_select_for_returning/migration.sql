-- ============================================================================
-- Phase P13 — the actual root cause of p13_3's remaining failure,
-- identified by direct empirical isolation (query logging + a minimal
-- raw-SQL repro), not by inspection alone: PostgreSQL's row-security
-- model applies a table's SELECT policies to a write's `RETURNING`
-- clause in addition to the write's own INSERT/UPDATE policy — Prisma's
-- `create()`/`update()` always generates a `RETURNING` clause to hydrate
-- the object it returns. `course_progress`/`lesson_progress` had
-- `is_platform_owner()` INSERT policies (p13_3) but no matching SELECT
-- policy, so the INSERT itself was permitted, but Postgres then rejected
-- the RETURNING clause's implicit read of the very row just inserted —
-- surfaced as the identical "new row violates row-level security policy"
-- error as an outright-blocked INSERT, which is why this was easy to
-- misdiagnose as the INSERT policy itself being wrong. Every other P13
-- write path (`course_orders`, `enrollments`, `payments`,
-- `payment_attempts`, `payment_proofs`, `revenue_ledger_entries`,
-- `academy_payouts`, `academy_payout_items`, `course_order_refunds`)
-- already had a matching SELECT policy for whichever context performs
-- its INSERT/UPDATE, so this gap was specific to these two tables.
-- ============================================================================

CREATE POLICY "course_progress_platform_select" ON "course_progress"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "lesson_progress_platform_select" ON "lesson_progress"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));
