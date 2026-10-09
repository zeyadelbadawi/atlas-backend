-- ATO review F10 — an absolute session lifetime.
--
-- Until now a refresh token rotated into a new one valid for another
-- `refreshTokenTtlDays` every time it was used, so a session (and a stolen
-- refresh cookie) that kept refreshing never ended. `session_started_at`
-- records when the session family began; the service never extends a
-- rotation past it plus the surface's maximum (30 days management, 90 days
-- academy by default).
--
-- Nullable, no default: adding it is a metadata-only change (no rewrite,
-- no long lock).
ALTER TABLE "refresh_tokens" ADD COLUMN "session_started_at" TIMESTAMP(3);

-- Backfill LIVE rows only (revoked/expired ones are never rotated again).
-- The real start of a family is its earliest row. So that every session
-- open at deploy time is not ended on the same day, each one keeps at
-- least seven more days: the start is clamped to (now - cap + 7 days)
-- using the default caps.
UPDATE "refresh_tokens" AS r
SET "session_started_at" = GREATEST(
      s.started,
      NOW() - CASE WHEN r."surface" = 'academy'
                   THEN INTERVAL '83 days'
                   ELSE INTERVAL '23 days' END
    )
FROM (
  SELECT "session_id", MIN("created_at") AS started
  FROM "refresh_tokens"
  GROUP BY "session_id"
) AS s
WHERE r."session_id" = s."session_id"
  AND r."revoked_at" IS NULL
  AND r."expires_at" > NOW();
