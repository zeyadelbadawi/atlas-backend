-- P49c — the refresh-token rotation guard.
--
-- Zoom invalidates the previous refresh token the instant it issues a new
-- one, so two concurrent refreshes race: one rotation is live and the
-- other is already dead. Writing the dead one second would overwrite the
-- live token and silently break the connection until somebody
-- re-authorized.
--
-- This column holds a SHA-256 of the current refresh token, and the
-- refresh write is conditional on it still matching the token the refresh
-- started from. A stale rotation therefore matches zero rows and writes
-- nothing — the database decides, not application code.
--
-- A digest rather than the token itself: the guard must not become the
-- place a credential sits in a WHERE clause.
--
-- Nullable, so this is safe against a non-empty table.

ALTER TABLE "academy_live_provider_connections"
  ADD COLUMN IF NOT EXISTS "refresh_token_fingerprint" TEXT;
