-- P48 — a session's HOST may read their own session under user context.
--
-- WHY THIS EXISTS. `live_sessions` is FORCE RLS. Two policies could already
-- return a row: `live_sessions_tenant_select` (needs
-- `app.current_organization_id`) and `live_sessions_enrolled_student_select`
-- (needs `app.current_user_id` plus a matching enrolment).
--
-- The student-facing endpoints run under USER context, because that is the
-- context in which RLS can independently agree that THIS caller may see
-- THIS session. That works for a student. It does not work for the
-- instructor hosting the class: a host is an academy member, not an
-- enrolled student, so no policy matched and the host's own session page
-- returned 404 — found by end-to-end testing against the real database,
-- where the unit tests had mocked the client away.
--
-- The fix is a policy as narrow as the one it sits beside: not "academy
-- members can read sessions", which would be a real widening, but "the
-- host named on this row may read this row". Guard still decides —
-- `describeJoinEligibility` independently establishes `isHost` — and RLS
-- now agrees for both audiences instead of silently refusing one.
--
-- SELECT only. A host schedules and edits through the academy-scoped
-- management routes, which carry tenant context and are unchanged.

CREATE POLICY "live_sessions_host_select" ON "live_sessions"
  FOR SELECT
  USING (
    "live_sessions"."host_user_id"::text = current_setting('app.current_user_id', true)
  );
