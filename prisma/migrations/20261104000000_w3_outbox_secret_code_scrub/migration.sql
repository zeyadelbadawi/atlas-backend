-- =============================================================================
-- W3 (Atlas Large-Scale Initiative) — strip emailed secret codes and settled
-- link tokens from existing `communication_outbox.values`.
--
-- THE DEFECT. `auth.email.otp` (sign-in code) and `auth.account.deletion_code`
-- (account-deletion code) declared no `credentialValues`, so the PLAINTEXT
-- six-digit code stayed in `communication_outbox.values ->> 'code'` for the
-- whole 90-day outbox retention, readable by the recipient
-- (`communication_outbox_self_select`) and by the platform owner. The code
-- now ships with `credentialValues: ['code']`, so every NEW row loses the
-- code as soon as its dispatch settles; this migration cleans the rows that
-- were written before the fix.
--
-- WHAT IT DOES. Removes JSON keys only — no row is deleted, no state, error,
-- timestamp or any other column changes:
--   1. `code` from every `auth.email.otp` / `auth.account.deletion_code` row
--      that has SETTLED (dispatched / suppressed / failed) or is older than
--      one hour. A row still pending inside its first hour may be an email
--      that has not rendered yet (code TTL 10 min, retry budget ~15 min);
--      it keeps its code and loses it on settle like every new row, and the
--      daily prune strips it after an hour regardless.
--   2. `token` from every SETTLED row of the four link-token keys. Rows
--      settled before `credentialValues: ['token']` existed were never
--      rewritten (the catalogue comment says so); every such token has long
--      expired, but there is no reason to keep it either.
--
-- IDEMPOTENT. Each UPDATE matches only rows that still carry the key, so a
-- second run changes nothing.
--
-- NO BACKUP TABLE — DELIBERATELY. The shared rule for data-changing
-- migrations is "write a backup table first". It does not apply here: the
-- only data removed are live or expired authentication secrets, and copying
-- them into a backup table would recreate exactly the exposure this
-- migration exists to end. Nothing of business value is lost: every code is
-- single-use with a 10-minute TTL (and only its HMAC lives in
-- `auth_email_challenges` / `account_deletion_challenges`), every token has a
-- TTL of at most 72 h, and the delivery facts (state, attempts, provider
-- rows, timestamps) are untouched. Recovery is neither possible nor wanted;
-- rollback = no-op.
--
-- RLS. Prisma migrations run as the migration owner role (superuser /
-- BYPASSRLS), so FORCE RLS on `communication_outbox` does not hide rows here.
-- =============================================================================

UPDATE "communication_outbox"
   SET "values" = "values" - 'code'
 WHERE "key" IN ('auth.email.otp', 'auth.account.deletion_code')
   AND jsonb_typeof("values") = 'object'
   AND jsonb_exists("values", 'code')
   AND (
     "state" IN ('dispatched', 'suppressed', 'failed')
     OR "created_at" < now() - INTERVAL '1 hour'
   );

UPDATE "communication_outbox"
   SET "values" = "values" - 'token'
 WHERE "key" IN (
     'auth.email.verification',
     'auth.password.reset',
     'academy.member.invited',
     'academy.learner.invited'
   )
   AND "state" IN ('dispatched', 'suppressed', 'failed')
   AND jsonb_typeof("values") = 'object'
   AND jsonb_exists("values", 'token');
