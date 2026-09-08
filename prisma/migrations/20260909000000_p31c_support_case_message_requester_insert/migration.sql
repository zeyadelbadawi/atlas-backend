-- Phase 8 follow-up — a real gap the phase's own security suite found
-- (P8-TENANT-007/010 failed against a live database before this
-- migration): `20260908000000_p31_support_audit_dashboards` added
-- `support_cases_requester_insert` so a tenant can create a ticket, and
-- `support_case_messages_requester_select` so they can read its thread —
-- but no INSERT policy for `support_case_messages`. `support_case_messages`
-- only ever had `support_case_messages_platform_insert`
-- (`is_platform_owner()`), so the tenant-facing create path could insert
-- the case row and was then refused when writing that case's FIRST
-- message ("new row violates row-level security policy"), failing the
-- whole transaction. A ticket is a subject plus a message thread, so
-- without this the create endpoint could not work at all.
--
-- Two conditions, both required:
--   1. The message must belong to a case the caller PERSONALLY requested
--      — the same predicate `support_case_messages_requester_select`
--      already uses, so a caller can never write into another
--      requester's thread (not even a colleague's in the same
--      organization).
--   2. `author_role` must be `'requester'`. This is the important half:
--      without it, a customer could insert a message attributed to
--      `'agent'` and fabricate an official Atlas support reply in their
--      own ticket thread. Agent replies stay exclusively on the
--      Platform-Owner path (`support_case_messages_platform_insert`,
--      unchanged).
CREATE POLICY "support_case_messages_requester_insert" ON "support_case_messages"
  FOR INSERT
  WITH CHECK (
    "author_role" = 'requester'::"support_case_message_author_role"
    AND EXISTS (
      SELECT 1 FROM "support_cases" sc
      WHERE sc."id" = "support_case_messages"."case_id"
        AND sc."requester_user_id"::text = current_setting('app.current_user_id', true)
    )
  );
