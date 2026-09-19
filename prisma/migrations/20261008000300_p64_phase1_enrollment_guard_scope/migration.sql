-- ============================================================================
-- P64 Phase 1 — CORRECTION to the `enrollments_guard_self_update` trigger
-- added by `20261008000000_p64_phase1_identity_rbac_foundation`.
--
-- The trigger's purpose is narrow: a STUDENT updating their OWN enrollment
-- row (the only student-facing write path) must not be able to change the
-- lifecycle/ownership columns — status out of `unavailable`, `revoked_at`,
-- `expires_at`, `access_source`, `course_id`, `academy_id`, `student_id`.
--
-- As first written it fired for every context without an organization id,
-- which also caught legitimate writers that never set one: the platform
-- owner paths (`enrollments_platform_update`, `runInUserContext(platformOwner)`),
-- database maintenance/seeding over the admin connection, and the test
-- fixtures. Reproduced by the P64 roster suite, where an admin-connection
-- `UPDATE` to simulate an expiry raised `insufficient_privilege`.
--
-- It now fires ONLY when the acting user IS the row's student and no
-- organization context is open — precisely the student self-update case.
-- ============================================================================

CREATE OR REPLACE FUNCTION enrollments_guard_self_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_user text := current_setting('app.current_user_id', true);
  v_org  text := current_setting('app.current_organization_id', true);
BEGIN
  IF v_user IS NOT NULL
     AND v_user <> ''
     AND v_user = OLD."student_id"
     AND (v_org IS NULL OR v_org = '')
  THEN
    IF NEW."student_id" IS DISTINCT FROM OLD."student_id"
       OR NEW."course_id" IS DISTINCT FROM OLD."course_id"
       OR NEW."academy_id" IS DISTINCT FROM OLD."academy_id"
       OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
       OR NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
       OR NEW."revoke_reason" IS DISTINCT FROM OLD."revoke_reason"
       OR NEW."access_source" IS DISTINCT FROM OLD."access_source"
       OR NEW."course_order_id" IS DISTINCT FROM OLD."course_order_id"
       OR (OLD."status" = 'unavailable' AND NEW."status" IS DISTINCT FROM OLD."status")
       OR (OLD."revoked_at" IS NOT NULL AND NEW."status" IS DISTINCT FROM OLD."status")
    THEN
      RAISE EXCEPTION 'enrollment lifecycle columns are immutable in a self context'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
