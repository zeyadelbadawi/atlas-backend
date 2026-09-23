-- P64 (Issue A) — an invitation created for a specific email may be
-- redeemed ONLY by an identity whose email matches the invited email.
--
-- Root cause: `claim_academy_invite(academy_id, token_hash)` claimed a
-- token on academy + hash + validity alone and never looked at
-- `academy_invites.email`, so an invite addressed to invited@example.com
-- was redeemable by ANY registering email that held the raw token. The
-- invited-email binding stored at creation was silently dropped at
-- redemption.
--
-- The claim is the authoritative, atomic, server-side enforcement point
-- (a single conditional UPDATE the registration path cannot bypass, even
-- with a hand-crafted API request). The email predicate is added here so
-- the binding is enforced in the same statement that consumes the use —
-- no room for a check-then-claim race. An invite with a NULL `email` is
-- an open invite (any address), preserving every existing invite.
--
-- The caller passes the registrant's email already run through the
-- project's canonical normalization (`normalizeEmail` = trim + lowercase),
-- and `createInvite` now stores the invited email through the same
-- function, so the comparison is a plain, case/whitespace-safe equality.

-- Replace the two-argument claim with an email-bound three-argument one.
-- Dropping the old arity removes the only code path that could consume an
-- invite without checking the invited email (defense in depth: no caller
-- remains, and none can accidentally reintroduce the bypass).
DROP FUNCTION IF EXISTS claim_academy_invite(text, text);

CREATE OR REPLACE FUNCTION claim_academy_invite(
  p_academy_id text,
  p_token_hash text,
  p_email text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed integer;
BEGIN
  UPDATE "academy_invites"
  SET "used_count" = "used_count" + 1
  WHERE "academy_id" = p_academy_id
    AND "token_hash" = p_token_hash
    AND "revoked_at" IS NULL
    AND "expires_at" > now()
    AND "used_count" < "max_uses"
    -- The binding: an addressed invite is redeemable only by its invitee;
    -- a NULL email is an open invite and matches any registrant.
    AND ("email" IS NULL OR "email" = p_email);
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed = 1;
END;
$$;
