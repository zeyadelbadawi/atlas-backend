-- P64 Phase 3 (AD-11) — the ONE write the completion evaluator makes to
-- `enrollments`: flipping `status` between `enrolled` and `completed` (and
-- `completed_at`) when the course's completion rule is met or ceases to
-- be met. Phase 1 deliberately removed the wide tenant UPDATE tier on
-- enrollments (a pending student could have enrolled themselves), so the
-- evaluator — which runs either as the learner (own progress) or in the
-- academy's tenant context (after a reviewer's grade or void) — gets a
-- SECURITY DEFINER that changes exactly these two columns and nothing
-- else, after verifying the caller is one of those two principals.
CREATE OR REPLACE FUNCTION set_enrollment_completion(p_enrollment_id text, p_completed boolean)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_student text;
  v_org text;
  v_status text;
  v_user text := current_setting('app.current_user_id', true);
  v_ctx_org text := current_setting('app.current_organization_id', true);
  v_count integer := 0;
BEGIN
  SELECT e."student_id", a."organization_id", e."status"::text
    INTO v_student, v_org, v_status
  FROM "enrollments" e
  JOIN "academies" a ON a."id" = e."academy_id"
  WHERE e."id" = p_enrollment_id;
  IF v_student IS NULL THEN
    RETURN 0;
  END IF;
  IF NOT ((v_user IS NOT NULL AND v_user = v_student) OR (v_ctx_org IS NOT NULL AND v_ctx_org = v_org)) THEN
    RAISE EXCEPTION 'enrollment completion update refused for %', p_enrollment_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Only the two lifecycle-neutral states move; revoked/expired/unavailable
  -- enrollments are never touched by completion.
  IF p_completed AND v_status = 'enrolled' THEN
    UPDATE "enrollments" SET "status" = 'completed', "completed_at" = now(), "updated_at" = now()
    WHERE "id" = p_enrollment_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSIF (NOT p_completed) AND v_status = 'completed' THEN
    UPDATE "enrollments" SET "status" = 'enrolled', "completed_at" = NULL, "updated_at" = now()
    WHERE "id" = p_enrollment_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;
  RETURN v_count;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_app') THEN
    REVOKE ALL ON FUNCTION set_enrollment_completion(text, boolean) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION set_enrollment_completion(text, boolean) TO "atlas_app";
  END IF;
END $$;
