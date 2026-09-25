-- P64 Communications C3 — resolve the STAFF recipients of an academy event.
--
-- THE PROBLEM THIS SOLVES. Several catalogue events are produced by a
-- LEARNER but addressed to STAFF: a submitted review must reach the
-- academy's moderators, a join request must reach its owner. `emit` runs
-- inside the producer's transaction, and that transaction is running in
-- the learner's own RLS context — where `academy_members_tenant_select`
-- has no tenant context to work with and `academy_members_self_select`
-- returns only the learner's own row. So the producer cannot discover who
-- to notify, and those events could not be implemented at all.
--
-- WHY A FUNCTION RATHER THAN THE ALTERNATIVES.
--   * Loosening `academy_members` RLS would let any learner enumerate an
--     academy's staff from any query — a far larger hole than the problem.
--   * Emitting after the transaction commits, in a staff context, breaks
--     the property the outbox exists for: the notification would no longer
--     be atomic with the business event, so a crash between the two loses
--     it silently. A review that exists with no moderator notification is
--     exactly the failure the outbox was built to prevent.
-- A narrow SECURITY DEFINER function keeps the emit inside the
-- transaction and confines the RLS bypass to one auditable statement,
-- following `is_platform_owner` and `touch_support_case_for_requester`.
--
-- WHAT IT DELIBERATELY DOES NOT DO. It returns USER IDS ONLY — no names,
-- no email addresses, no roles, no membership metadata. Everything the
-- caller does with those ids still runs under normal RLS, and the
-- recipient's own address is read later by the dispatcher under the
-- platform-owner context it already uses. It is `STABLE`, so it cannot
-- write anything, and `SET search_path = public` stops a shadowed table
-- from being substituted underneath it.
--
-- Only `atlas_app` may execute it; PUBLIC is revoked, matching every
-- other SECURITY DEFINER helper in this schema.

CREATE OR REPLACE FUNCTION academy_notification_recipients(
  p_academy_id text,
  p_roles text[]
)
RETURNS TABLE (user_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT am."user_id"
  FROM "academy_members" am
  WHERE am."academy_id" = p_academy_id
    -- Only ACTIVE memberships: a removed or suspended moderator must stop
    -- receiving an academy's work items the moment they lose the role.
    AND am."status" = 'active'
    AND am."role"::text = ANY(p_roles)
  ORDER BY am."user_id";
$$;

REVOKE ALL ON FUNCTION academy_notification_recipients(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION academy_notification_recipients(text, text[]) TO "atlas_app";
