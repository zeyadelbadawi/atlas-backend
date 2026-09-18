-- P63d — what the HTTPS probe actually saw. A production test showed a
-- custom hostname whose edge TLS handshake succeeded while the edge
-- returned 525 (origin handshake failed): "reachable" was recorded, the
-- domain was advertised as live, and visitors got an error page. The probe
-- now records the HTTP status it received and, when the hostname is not
-- reachable, a stable reason code, so the customer and the Platform Owner
-- see WHY ("the edge returned 525") instead of a bare "unreachable".
-- Additive, nullable; NULL on every existing row means "no detail
-- recorded", exactly the prior behaviour. Rollback: drop the two columns.
ALTER TABLE "domain_connections"
  ADD COLUMN IF NOT EXISTS "https_status_code" INTEGER,
  ADD COLUMN IF NOT EXISTS "https_failure_reason" TEXT;
