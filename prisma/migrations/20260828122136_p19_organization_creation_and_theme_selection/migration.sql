-- Phase P19 — Development E2E Flow Completion.
--
-- Additive only, single column. Written by hand (not via `prisma migrate
-- dev`, which is non-interactive-incompatible in this environment AND —
-- more importantly — would have proposed DROPPING the `search_vector`
-- generated columns on `academies`/`courses`/`organizations`/`users`,
-- because those P17 columns are deliberately raw-SQL-only and never
-- represented in `schema.prisma` (matching this codebase's established
-- `citext`/generated-tsvector precedent: a column only ever queried via
-- raw SQL isn't added to schema.prisma, so a naive schema diff always
-- proposes removing it). This migration touches only what it says.
--
-- No RLS policy change needed: `provisioning_requests` already has RLS
-- FORCE'd (P14 migration) with existing SELECT/INSERT/UPDATE policies
-- scoped by `organization_id` — a new nullable scalar column needs no
-- new policy.

ALTER TABLE "provisioning_requests" ADD COLUMN "selected_theme_key" TEXT;
