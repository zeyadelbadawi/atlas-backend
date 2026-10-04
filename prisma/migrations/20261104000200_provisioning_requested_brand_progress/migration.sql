-- ============================================================================
-- W2 — Academy provisioning: server-side branding and honest progress.
--
-- Purely additive, safe on production data (no backfill, no rewrite):
--
--   * `requested_brand` (JSONB, NULL) — the validated brand the owner chose in
--     the setup form (palette inputs; the logo only ever as a media-asset
--     reference once the Academy exists, never a data: URI). Applied by the
--     orchestrator's `branding` step. NULL for every request created before
--     this migration: their `branding` step keeps being `skipped`, exactly as
--     before.
--   * `last_progress_at` (TIMESTAMP(3), NULL) — stamped every time the
--     orchestrator starts, finishes or fails a step. The status endpoint
--     derives `stalled` from it. NULL on older rows: the API falls back to
--     `started_at`/`created_at`.
--   * an index on (organization_id, requested_subdomain) — the create path
--     now looks for an active request for the same address in the same
--     organization (two tabs, one address) under an advisory lock.
--
-- Table-level grants and the existing row-level policies on
-- `provisioning_requests` already cover new columns; no policy change.
--
-- Recovery: DROP INDEX "provisioning_requests_organization_id_requested_subdomain_idx";
--           ALTER TABLE "provisioning_requests" DROP COLUMN "last_progress_at",
--                                               DROP COLUMN "requested_brand";
-- ============================================================================

ALTER TABLE "provisioning_requests"
  ADD COLUMN "requested_brand" JSONB,
  ADD COLUMN "last_progress_at" TIMESTAMP(3);

CREATE INDEX "provisioning_requests_organization_id_requested_subdomain_idx"
  ON "provisioning_requests" ("organization_id", "requested_subdomain");
