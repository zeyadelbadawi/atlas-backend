-- Phase 10.4 — backfill missing Academy subdomain allocations.
--
-- THE DEFECT THIS REPAIRS. Atlas has two Academy-creation paths:
-- `ProvisioningOrchestratorService`, which allocated a subdomain as its
-- own step, and `AcademiesService.create` — the ordinary "New Academy"
-- flow — which did not. Every Academy created through the second path
-- therefore had no `subdomain_allocations` row, so
-- `resolve_public_hostname` matched nothing and its public website
-- answered "not found" at `{slug}.{baseDomain}`.
--
-- Confirmed against production before writing this: five Academies, two
-- allocations. DNS, TLS, Cloudflare and origin routing were all working
-- correctly the entire time — the missing row was the only fault.
--
-- The code fix (allocating inside `AcademiesService.create`'s existing
-- transaction) prevents new Academies from being affected. This migration
-- repairs the ones already created.

-- The subdomain IS the slug, matching both the code path above and the
-- rows provisioning already created (verified: `asgypt`/`khattab`
-- allocations match their academy slugs exactly).
--
-- `full_host` is left NULL here rather than composed from a base domain
-- guessed in SQL: `resolve_public_hostname` matches on the `subdomain`
-- label, not on `full_host`, so a NULL is functionally complete, and
-- inventing a hostname from a value this migration cannot read from the
-- environment would be a guess written into data.
--
-- WHERE NOT EXISTS makes this safely re-runnable and means it can never
-- disturb an allocation that provisioning already created.
INSERT INTO "subdomain_allocations" ("id", "academy_id", "subdomain", "status", "created_at", "updated_at")
SELECT
    gen_random_uuid()::text,
    a."id",
    a."slug",
    'assigned',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "academies" a
WHERE NOT EXISTS (
    SELECT 1 FROM "subdomain_allocations" sa WHERE sa."academy_id" = a."id"
  )
  -- Skip any slug already claimed by a different Academy's allocation.
  -- The unique index would reject it anyway; skipping turns a migration
  -- failure into a row an operator can investigate deliberately, rather
  -- than blocking the deploy for everyone else.
  AND NOT EXISTS (
    SELECT 1 FROM "subdomain_allocations" sa2 WHERE sa2."subdomain" = a."slug"
  );
