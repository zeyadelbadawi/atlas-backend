-- Fix round (20 Oct 2026, team) — a REJECTED learner can register again.
--
-- THE DEFECT
--   Rejecting a pending registration (`AcademyStudentsService.reject`) keeps
--   the `academy_students` row and marks it `inactive`. The reject dialog
--   tells staff "They can register again later", but every way back was
--   shut: registering again on the academy website found the row and
--   answered `errors.auth.alreadyLearnerHere`, and the row cannot be
--   changed from the learner's own context — `academy_students` has no
--   self UPDATE policy (only self SELECT / INSERT / DELETE), by design.
--
-- WHAT THIS ADDS — one narrow SECURITY DEFINER function, nothing else:
--   `academy_student_reapply(academy, status, source, host)` puts the
--   CALLER's own rejected membership of that academy back into the
--   registration flow, with the status the registration policy gave it
--   (`pending` under approval, `active` under open or a claimed invite —
--   decided by the application exactly as for a brand-new registration).
--   It changes a row only when ALL of these hold:
--     * `user_id` is `app.current_user_id` (no context → nothing);
--     * `status = 'inactive'` — on `academy_students` that state is written
--       by exactly one path, the staff rejection of a pending registration
--       (`AcademyStudentsService.reject`; the P21 backfill and every
--       admission insert `active`/`pending`), so it means "rejected";
--     * `blocked_at IS NULL` — a blocked learner is never reopened: the
--       block stays effective until staff lift it;
--   and it only ever writes `active`/`pending` with a self-registration
--   source (`self_signup`/`invite`). `joined_at` restarts (the roster's
--   "Joined" date and newest-first order follow the new application);
--   `blocked_*`, `invited_by`, `name_key` and `name_unique_exempt` are
--   untouched (the row already holds its name key, so W4's name rule is
--   unaffected). Returns the row id, or NULL when nothing qualified.
--
-- Staff never need this: they act under the tenant context, where
-- `academy_students_tenant_update` already admits their writes.
--
-- No table, column, policy or data changes. Idempotent (CREATE OR REPLACE).
-- RECOVERY: DROP FUNCTION academy_student_reapply(text, text, text, text);
-- (re-registration after a rejection then answers "already a learner" again).

CREATE OR REPLACE FUNCTION academy_student_reapply(
  p_academy_id text,
  p_status text,
  p_source text,
  p_registered_via_host text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id text := nullif(current_setting('app.current_user_id', true), '');
  v_id text;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_status NOT IN ('active', 'pending') OR p_source NOT IN ('self_signup', 'invite') THEN
    RAISE EXCEPTION 'academy_student_reapply: refused status % / source %', p_status, p_source
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE "academy_students"
     SET "status" = p_status::"academy_member_status",
         "source" = p_source::"academy_student_source",
         "registered_via_host" = p_registered_via_host,
         -- `joined_at` is timestamp WITHOUT time zone holding UTC (Prisma).
         "joined_at" = (now() AT TIME ZONE 'UTC')
   WHERE "academy_id" = p_academy_id
     AND "user_id" = v_user_id
     AND "status" = 'inactive'
     AND "blocked_at" IS NULL
  RETURNING "id" INTO v_id;

  RETURN v_id;
END;
$$;

-- Callable by the application role only (the identity-resolver convention,
-- 20261021000000_identity_tables_rls).
REVOKE ALL ON FUNCTION academy_student_reapply(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION academy_student_reapply(text, text, text, text) TO "atlas_app";
