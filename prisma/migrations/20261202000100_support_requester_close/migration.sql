-- B5 (UX audit) V35 — a customer can close their own support ticket.
--
-- `support_cases` has requester SELECT and INSERT policies but, by design,
-- no requester UPDATE policy: RLS is row-scoped, so any policy that let a
-- requester change `status` would equally let them rewrite `subject`,
-- `requester_name` and `requester_email` (see 20260918000000_p40's header,
-- which solved the same problem for the activity timestamp).
--
-- THE FIX, the same technique as `touch_support_case_for_requester`: a
-- SECURITY DEFINER function that does exactly one thing — move a ticket the
-- CALLER PERSONALLY REQUESTED to `closed` (and bump `updated_at`, which
-- orders the support queue). It names no other column, so nothing else can
-- change, and it cannot reach anyone else's ticket. Closing is one-way from
-- the customer's side; only Atlas support (the Platform Owner status
-- endpoint) can set any other status. Returns whether a row changed, so the
-- caller can tell "closed now" from "already closed" (idempotent).
--
-- No table, column, policy or data change. Idempotent (CREATE OR REPLACE).
-- RECOVERY: DROP FUNCTION close_support_case_for_requester(text);

CREATE OR REPLACE FUNCTION close_support_case_for_requester(p_case_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_changed integer;
BEGIN
  UPDATE "support_cases"
     SET "status" = 'closed',
         "updated_at" = now()
   WHERE "id" = p_case_id
     AND "status" <> 'closed'
     -- The caller must be the requester. A NULL context (no user set)
     -- makes this comparison NULL, which is never true, so a context-free
     -- connection closes nothing.
     AND "requester_user_id"::text = current_setting('app.current_user_id', true);
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed > 0;
END;
$$;

-- SECURITY DEFINER runs as the function owner, so EXECUTE is granted
-- deliberately and to the application role only.
REVOKE ALL ON FUNCTION close_support_case_for_requester(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION close_support_case_for_requester(text) TO "atlas_app";
