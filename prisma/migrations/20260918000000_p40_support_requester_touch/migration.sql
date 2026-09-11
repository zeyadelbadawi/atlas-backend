-- Phase 11.8 — let a requester's reply bump their own ticket's activity
-- timestamp, and nothing else.
--
-- THE PROBLEM. `support_cases` has `support_cases_requester_select` and
-- `support_cases_requester_insert`, but no UPDATE policy for a requester.
-- Posting a reply must move `updated_at`, because that is what orders the
-- support queue — without it a customer's reply is invisible to the
-- people meant to answer it. With no UPDATE policy the write is refused
-- outright and the whole reply transaction fails.
--
-- WHY NOT JUST ADD AN UPDATE POLICY. Postgres row-level security is
-- row-scoped, not column-scoped: a policy permissive enough to let a
-- requester touch `updated_at` would equally let them rewrite `status`,
-- `subject`, `requester_name` and `requester_email` on their own ticket.
-- A customer silently closing or retitling a ticket — or editing the
-- email address support replies to — is not a capability this feature
-- needs, and RLS is the boundary here, not the absence of an endpoint.
--
-- THE FIX. A SECURITY DEFINER function that does exactly one thing:
-- set `updated_at = now()` on a case the CALLER PERSONALLY REQUESTED.
-- The predicate is the same one `support_cases_requester_select` uses, so
-- it cannot touch anyone else's ticket, and it cannot change any other
-- column because it does not name any. This is the same technique
-- `resolve_public_hostname` already uses in this codebase for a
-- capability that RLS cannot express.

CREATE OR REPLACE FUNCTION touch_support_case_for_requester(p_case_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE "support_cases"
     SET "updated_at" = now()
   WHERE "id" = p_case_id
     -- The caller must be the requester. A NULL context (no user set)
     -- makes this comparison NULL, which is never true, so a
     -- context-free connection updates nothing.
     AND "requester_user_id"::text = current_setting('app.current_user_id', true);
END;
$$;

-- SECURITY DEFINER runs as the function owner, so EXECUTE must be granted
-- deliberately and to the application role only.
REVOKE ALL ON FUNCTION touch_support_case_for_requester(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION touch_support_case_for_requester(text) TO "atlas_app";
