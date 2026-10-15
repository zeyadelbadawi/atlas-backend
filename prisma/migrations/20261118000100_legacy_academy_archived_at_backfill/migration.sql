-- ============================================================================
-- B0-SEC-15 follow-up (OD-18) — record `archived_at` on academies the
-- pre-D5-2 account-deletion path archived without it.
--
-- THE DEFECT THIS REPAIRS
--   From Phase 10.6 (fb559df) until D5-2 (4cd7460), deleting an account ran
--   `AccountDeletionService.archiveOwnedAcademies`, which for every
--   organization the person owned did exactly one thing:
--
--     tx.academy.updateMany({
--       where: { organizationId, status: { not: 'archived' } },
--       data:  { status: 'archived' },
--     })
--
--   Written: `status = 'archived'` and (Prisma `@updatedAt`) `updated_at`.
--   NOT written: `archived_at`, `archive_reason`, `archive_feedback`, no
--   `academy.archived` audit row, no domain release. Moments later, in the
--   same request, the owner was anonymised (`users.status = 'deleted'`,
--   `users.deleted_at`) and an `account.deleted` /
--   `account.deleted_by_platform_owner` audit row was written (best effort).
--   Rows left that way read as LIVE to `resolve_learner_academies` and
--   `resolve_academy_registration_policy` (both filter `archived_at IS
--   NULL`), and their media is never purge-eligible
--   (`ArchivedMediaPurgeService` keys the 30-day grace on `archived_at`).
--
-- ELIGIBLE (changed) — every condition, nothing inferred from names:
--   * `academies.status = 'archived'` AND `archived_at IS NULL`;
--   * the organization's owner is deleted by BOTH markers the deletion path
--     writes together: `users.status = 'deleted'` AND `deleted_at IS NOT NULL`;
--   * no trace of the normal archive path: `archive_reason` and
--     `archive_feedback` NULL, and no `academy.archived` audit row for it;
--   * the archive write belongs to that deletion: `updated_at` lies in
--     [deletion instant − 1 hour, deletion instant + 5 minutes]. The
--     archive ran a few seconds BEFORE the anonymisation in the same
--     request; the hour absorbs a slow request, the 5 minutes clock skew.
--     The deletion instant is the earliest `account.deleted*` audit row
--     for the owner (an event record), else `users.deleted_at` (written in
--     the same transaction as that audit row, which was best effort).
--
-- NEVER CHANGED: live academies; academies with `archived_at` already set
-- (the normal path, and account deletion since D5-2); archived rows whose
-- owner is live (an owner's own Delete before `archived_at` existed, or a
-- PATCH before 50e4bb2 — "not recorded" stays NULL, as
-- 20260917000000_p39_academy_archive_metadata decided); and AMBIGUOUS rows
-- (owner deleted but one marker missing, normal-path evidence, or an
-- archive write outside the window — e.g. archived long before the
-- deletion, or touched after it). Release verify reports each count.
--
-- WHAT IS WRITTEN — `archived_at` ONLY, and only on eligible rows:
--   * `archived_at` = the instant this migration runs (transaction start,
--     UTC), the SAME value for every row. Deliberately NOT the evidenced
--     deletion instant: the deletion path has existed since September
--     2026, so most of these rows are already more than 30 days old, and
--     back-dating them would make their media purge-eligible at the very
--     next 6-hourly sweep (when FLAG_MEDIA_ARCHIVE_PURGE_MODE=on) —
--     destroying R2 / hosted-video bytes as a side effect of a deploy,
--     beyond the reach of the pre-migration database backup (which holds
--     no media and is pruned after 14 days). Stamping the run instant
--     starts a fresh 30-day grace instead, the same grace any archive
--     gets, and leaves a full rollback window. The evidenced instant is
--     kept in the backup table below, so an owner who prefers the true
--     dates can re-stamp from it later (docs/ops/LEGACY-ARCHIVED-AT-BACKFILL.md).
--   * `archive_reason` stays NULL, exactly as D5-2's account deletion
--     writes it (the closed vocabulary has no account-deletion value; the
--     owner deleted their account, not the academy).
--   * `status`, `updated_at` and every other column are untouched; no row
--     is deleted; domains, hostname caches, usage and media are untouched;
--     nothing is enqueued (no application code runs in a migration).
--
-- RLS. `academies`, `users` and `audit_log_entries` are FORCE RLS, so a
-- migrating role subject to RLS would silently match nothing; the role
-- must be SUPERUSER or BYPASSRLS (asserted below, like
-- 20261104000300_w4_name_key_foundation). RLS is therefore inert for these
-- statements and the WHERE clause is the only fence: every UPDATE is keyed
-- to the ids just copied to the backup table.
--
-- BACKUP / ROLLBACK. Each changed row's id, owner, previous values and the
-- evidence are first copied to
-- `atlas_migration_backups.legacy_academy_archived_at_backfill` (the W4 M4 /
-- W8 convention: outside Prisma's view, never readable by `atlas_app`).
-- Revert (only rows still carrying the stamped value):
--   UPDATE "academies" a
--      SET "archived_at" = b."previous_archived_at"
--     FROM atlas_migration_backups.legacy_academy_archived_at_backfill b
--    WHERE b."academy_id" = a."id"
--      AND a."archived_at" = b."applied_archived_at";
--
-- IDEMPOTENT: a re-run matches no row (`archived_at` is no longer NULL)
-- and writes nothing. One transaction; `lock_timeout` fails fast.
-- ============================================================================

SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION
      'legacy_academy_archived_at_backfill: the migrating role % must be SUPERUSER or BYPASSRLS — under FORCE RLS this backfill would silently match nothing',
      current_user;
  END IF;
END
$$;

-- Writers wait while the backfill runs (milliseconds); an archive racing it
-- can neither be missed nor double-stamped.
LOCK TABLE "academies" IN SHARE ROW EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------
-- 1. Backup table (operator-only).
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS atlas_migration_backups;
REVOKE ALL ON SCHEMA atlas_migration_backups FROM PUBLIC;

CREATE TABLE IF NOT EXISTS atlas_migration_backups."legacy_academy_archived_at_backfill" (
  "academy_id"              text         NOT NULL,
  "organization_id"         text         NOT NULL,
  "owner_user_id"           text         NOT NULL,
  -- What the row held before (always 'archived' / NULL / NULL by the
  -- eligibility rule; recorded rather than assumed).
  "previous_status"         text         NOT NULL,
  "previous_archived_at"    timestamp(3),
  "previous_archive_reason" text,
  -- The evidence: the old path's archive write, and the deletion instant.
  "academy_updated_at"      timestamp(3) NOT NULL,
  "deletion_at"             timestamp(3) NOT NULL,
  "deletion_source"         text         NOT NULL
    CHECK ("deletion_source" IN ('audit_account_deleted', 'user_deleted_at')),
  -- What this migration wrote.
  "applied_archived_at"     timestamp(3) NOT NULL,
  "run_at"                  timestamptz  NOT NULL,
  PRIMARY KEY ("academy_id", "run_at")
);

DO $$
BEGIN
  REVOKE ALL ON TABLE atlas_migration_backups."legacy_academy_archived_at_backfill" FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_app') THEN
    REVOKE ALL ON TABLE atlas_migration_backups."legacy_academy_archived_at_backfill" FROM "atlas_app";
  END IF;
  ALTER TABLE atlas_migration_backups."legacy_academy_archived_at_backfill" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE atlas_migration_backups."legacy_academy_archived_at_backfill" FORCE ROW LEVEL SECURITY;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Backfill: copy the eligible rows, stamp exactly those, check.
--    The eligibility query is the one Release verify runs read-only
--    (deploy/release-verify/remote.sh, LEGACY_ARCHIVE_SQL); keep them equal.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_run_at     timestamptz  := now();
  -- `archived_at` is timestamp WITHOUT time zone holding UTC (Prisma);
  -- converted explicitly so a non-UTC session TimeZone cannot skew it.
  v_applied    timestamp(3) := (now() AT TIME ZONE 'UTC');
  v_backed_up  integer;
  v_changed    integer;
  v_remaining  integer;
BEGIN
  INSERT INTO atlas_migration_backups."legacy_academy_archived_at_backfill"
    ("academy_id", "organization_id", "owner_user_id", "previous_status",
     "previous_archived_at", "previous_archive_reason", "academy_updated_at",
     "deletion_at", "deletion_source", "applied_archived_at", "run_at")
  SELECT c."id", c."organization_id", c."owner_user_id", c."status"::text,
         c."archived_at", c."archive_reason", c."updated_at",
         c."deletion_at", c."deletion_source", v_applied, v_run_at
    FROM (
      SELECT a."id", a."organization_id", o."owner_user_id", a."status",
             a."archived_at", a."archive_reason", a."archive_feedback",
             a."updated_at", u."status" AS owner_status, u."deleted_at",
             coalesce(ev."audited_at", u."deleted_at") AS deletion_at,
             CASE WHEN ev."audited_at" IS NOT NULL
                  THEN 'audit_account_deleted' ELSE 'user_deleted_at' END AS deletion_source,
             EXISTS (
               SELECT 1 FROM "audit_log_entries" l
                WHERE l."action" = 'academy.archived' AND l."target_id" = a."id"
             ) AS normal_path_audit
        FROM "academies" a
        JOIN "organizations" o ON o."id" = a."organization_id"
        JOIN "users" u ON u."id" = o."owner_user_id"
        LEFT JOIN LATERAL (
          SELECT min(l."occurred_at") AS audited_at
            FROM "audit_log_entries" l
           WHERE l."target_type" = 'user'
             AND l."target_id" = u."id"
             AND l."action" IN ('account.deleted', 'account.deleted_by_platform_owner')
        ) ev ON true
       WHERE a."status" = 'archived'
         AND a."archived_at" IS NULL
         AND (u."status" = 'deleted' OR u."deleted_at" IS NOT NULL)
    ) c
   WHERE c."owner_status" = 'deleted'
     AND c."deleted_at" IS NOT NULL
     AND c."archive_reason" IS NULL
     AND c."archive_feedback" IS NULL
     AND NOT c."normal_path_audit"
     AND c."updated_at" >= c."deletion_at" - interval '1 hour'
     AND c."updated_at" <= c."deletion_at" + interval '5 minutes';
  GET DIAGNOSTICS v_backed_up = ROW_COUNT;

  UPDATE "academies" a
     SET "archived_at" = v_applied
    FROM atlas_migration_backups."legacy_academy_archived_at_backfill" b
   WHERE b."run_at" = v_run_at
     AND b."academy_id" = a."id"
     AND a."status" = 'archived'
     AND a."archived_at" IS NULL;
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  IF v_changed <> v_backed_up THEN
    RAISE EXCEPTION
      'legacy_academy_archived_at_backfill: backed up % row(s) but stamped % — rolled back',
      v_backed_up, v_changed;
  END IF;

  -- Postcondition: nothing this rule calls eligible is left.
  SELECT count(*) INTO v_remaining
    FROM "academies" a
    JOIN atlas_migration_backups."legacy_academy_archived_at_backfill" b
      ON b."academy_id" = a."id" AND b."run_at" = v_run_at
   WHERE a."archived_at" IS DISTINCT FROM v_applied;
  IF v_remaining > 0 THEN
    RAISE EXCEPTION
      'legacy_academy_archived_at_backfill: postcondition failed (% backed-up row(s) not stamped)',
      v_remaining;
  END IF;

  RAISE NOTICE 'legacy_academy_archived_at_backfill: % academy row(s) stamped archived_at = % (UTC)',
    v_changed, v_applied;
END
$$;
