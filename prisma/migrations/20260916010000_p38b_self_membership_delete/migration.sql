-- Phase 10.6 — let a user remove their OWN memberships.
--
-- WHY THIS IS NEEDED. `organization_memberships`, `academy_members` and
-- `academy_students` had no DELETE policy of any kind, so RLS refused
-- every delete against them. That was correct until now: nothing in Atlas
-- ever removed a membership, so the safest policy was none.
--
-- Account deletion changes that. Without these policies the delete
-- silently matches zero rows and REPORTS SUCCESS — which is exactly what
-- happened while building this: the account was anonymised and could no
-- longer sign in, but its membership rows survived, so a deleted person
-- still appeared in academy member lists. A silent no-op is the worst
-- possible failure here, because everything looks like it worked.
--
-- WHY THESE POLICIES ARE SAFE. Each is scoped to the acting user's own
-- rows and nothing else:
--
--     user_id = app.current_user_id
--
-- A user can remove themselves. They cannot remove anybody else, in their
-- own organization or any other — the policy has no branch that would
-- allow it. This is strictly narrower than the SELECT policies already on
-- these tables, which let a member see their colleagues.
--
-- `current_setting(..., true)` returns NULL when no user context is set,
-- and `user_id = NULL` is never true, so a context-free connection still
-- deletes nothing.

CREATE POLICY "organization_memberships_self_delete" ON "organization_memberships"
  FOR DELETE
  USING ("user_id" = current_setting('app.current_user_id', true));

CREATE POLICY "academy_members_self_delete" ON "academy_members"
  FOR DELETE
  USING ("user_id" = current_setting('app.current_user_id', true));

CREATE POLICY "academy_students_self_delete" ON "academy_students"
  FOR DELETE
  USING ("user_id" = current_setting('app.current_user_id', true));

-- `course_instructors` already has a DELETE policy (added when instructor
-- assignment became editable) and is deliberately left untouched.
