-- Phase 10.6 — record WHY an Academy was deleted.
--
-- Atlas's Academy delete is archival: `academies` has no DELETE RLS policy
-- at all, by design, because courses, enrolments, orders and revenue
-- entries hang off the row and destroying it would take a customer's
-- financial history with it. "Deleted" therefore means `status =
-- 'archived'`, the public website goes offline, and the plan's academy
-- allowance is released.
--
-- Since the row survives, the reason belongs ON it — no separate
-- tombstone table is needed, and none is created.
--
-- All three columns are NULLABLE with no default, so this migration
-- rewrites no existing row and cannot fail on production data. Academies
-- archived before this shipped keep NULL, which reads correctly as "not
-- recorded" rather than being backfilled with a guess.

ALTER TABLE "academies"
  ADD COLUMN "archived_at" TIMESTAMP(3),
  ADD COLUMN "archive_reason" TEXT,
  ADD COLUMN "archive_feedback" TEXT;

-- NOTE ON PRIVILEGES. No GRANT is needed: `atlas_app` already holds
-- UPDATE on `academies` (archiving is an UPDATE, and always has been),
-- and column-level grants are not used on this table. The existing
-- academies_update RLS policy governs who may write these columns exactly
-- as it governs `status` — an owner or administrator of the academy's own
-- organization, and nobody else.
