# Legacy academy `archived_at` backfill (OD-18, B0-SEC-15 follow-up)

Migration: `prisma/migrations/20261118000100_legacy_academy_archived_at_backfill/migration.sql`
Diagnostic: `deploy/release-verify/remote.sh` (`legacy_archive_facts`, mode `archive`, also part of `facts`)
Tests: `test/legacy-archived-at-backfill.e2e-spec.ts`, `src/config/release-verify-legacy-archive.spec.ts`

## 1. What went wrong

From Phase 10.6 (`fb559df`, 11 Sep 2026) until D5-2 (`4cd7460`, 15 Oct 2026),
`AccountDeletionService.archiveOwnedAcademies` archived the owned academies of a
deleted account with one bare statement per organization:

```ts
tx.academy.updateMany({
  where: { organizationId, status: { not: 'archived' } },
  data:  { status: 'archived' },
});
```

(`git show 4cd7460^:src/identity/services/account-deletion.service.ts`, lines 290-319;
the statement is the same in every revision from `fb559df` to `a4ced30`.)

It wrote `status = 'archived'` and, through Prisma's `@updatedAt`, `updated_at`. It did
**not** write `archived_at`, `archive_reason` or `archive_feedback`, wrote no
`academy.archived` audit row, released no domain and dropped no hostname cache. Moments
later in the same request the owner was anonymised (`users.status = 'deleted'`,
`users.deleted_at = now`) and an `account.deleted` / `account.deleted_by_platform_owner`
audit row (`target_type = 'user'`, `target_id = <user id>`) was written best-effort.

Effects of `archived_at IS NULL` on such a row:

- `resolve_learner_academies` and `resolve_academy_registration_policy`
  (migrations `20261008000100`, `20261008000000`) filter on `archived_at IS NULL`, so they
  treat the academy as live. A former learner still sees it in their academy list, and the
  registration policy still resolves, where it should give 404.
- `ArchivedMediaPurgeService` keys the 30-day grace on `archived_at`. `isPurgeEligible`
  never makes a row with `archived_at IS NULL` eligible, so its media is kept forever.

## 2. Eligibility rule (the rows the migration changes)

A row is changed only when **all** of these hold:

| # | Condition | Why |
|---|---|---|
| 1 | `academies.status = 'archived'` and `archived_at IS NULL` | what the old path left behind |
| 2 | the organization's `owner_user_id` user has `status = 'deleted'` **and** `deleted_at IS NOT NULL` | the deletion path writes both markers together |
| 3 | `archive_reason IS NULL`, `archive_feedback IS NULL`, and no `academy.archived` audit row has `target_id` = the academy | the normal archive path leaves at least one of these |
| 4 | `updated_at` is in `[D − 1 hour, D + 5 minutes]`, where D is the deletion instant (§3) | the archive write belongs to that deletion: it ran seconds before the anonymisation in the same request. The hour allows for a slow request and the 5 minutes for clock skew |

Rows that are **never changed** (Release verify reports a count for each class):

- live academies, including live academies whose owner is deleted (`live academies of deleted owners`);
- rows where `archived_at` is already set: the normal archive path, and account deletion since D5-2 (`already recorded`);
- archived rows with `archived_at IS NULL` whose owner is **live**: an owner's own Delete
  before `archived_at` existed, or a PATCH to `archived` before `50e4bb2`. Migration
  `20260917000000_p39` decided that "not recorded" stays NULL (`out of scope`);
- **ambiguous** rows. The owner is deleted, but one of the following applies:
  - only one deletion marker is set (`owner deletion marker partial`);
  - there is normal-archive evidence: a reason, feedback or an `academy.archived` audit row (`normal-archive evidence`);
  - the archive write falls outside the window, for example archived days before the deletion, a deletion retried after a failure, or a row touched after the deletion (`outside the deletion window`).

  These need a person to look at them. The migration never guesses.

## 3. Timestamp rule

**Evidence: the deletion instant D**, recorded per row in the backup table. Sources, in this order:

1. the earliest `account.deleted` / `account.deleted_by_platform_owner` audit row for the
   owner (`occurred_at`). This is an event record (`deletion_source = 'audit_account_deleted'`);
2. `users.deleted_at`. It is written in the same transaction as that audit row and is
   present even when the best-effort audit write failed (`deletion_source = 'user_deleted_at'`).

The old archive write's own `updated_at` is also recorded (`academy_updated_at`). The
rule uses it only to prove the link to the deletion (condition 4), because later writes
can move it. A row with neither source does not exist: condition 2 requires `deleted_at`.

**Value written to `archived_at`: the instant the migration runs.** This is the transaction
start in UTC, and every stamped row gets the same value. It is deliberately **not** D, and
this is the "safer semantics" choice:

- The old path was live from 11 Sep 2026, so most legacy rows have a D more than 30 days old.
- Back-dating `archived_at` to D would make their media purge-eligible at the **next
  6-hourly sweep** after the deploy, whenever `FLAG_MEDIA_ARCHIVE_PURGE_MODE=on`. A
  deploy would then destroy media bytes in R2 and Stream as a side effect.
- That deletion cannot be undone. The pre-migration database backup holds no media bytes,
  and `backup.sh` keeps backups for only 14 days.
- Stamping the run instant gives these academies the same fresh 30-day grace as any
  archive, and leaves a full window to review and roll back before anything can be purged.

`now()` is used here as the *start of the grace*, not as a guess at when the archive
happened. The real dates are not lost: they are in the backup table (§6). If the owner
decides the true dates should drive the purge, a follow-up migration can re-stamp
`archived_at` from them:

```sql
-- Only after an explicit owner decision; makes rows with D older than 30 days purge-eligible at the next sweep.
UPDATE "academies" a SET "archived_at" = b."deletion_at"
  FROM atlas_migration_backups.legacy_academy_archived_at_backfill b
 WHERE b."academy_id" = a."id" AND a."archived_at" = b."applied_archived_at";
```

`archive_reason` stays NULL. D5-2's account deletion writes no reason either, and the
closed vocabulary (`ACADEMY_ARCHIVE_REASONS`) has no account-deletion value.

## 4. What the migration does and does not do

- It asserts the migrating role is SUPERUSER or BYPASSRLS, and aborts otherwise.
  `academies`, `users` and `audit_log_entries` are FORCE RLS, so a role subject to RLS
  would match nothing, silently.
- Production applies migrations over the superuser `DATABASE_URL` connection (`deploy.sh`
  lines 1016-1023), so RLS is inert for these statements and the WHERE clause is the only fence.
  The UPDATE is keyed to the ids it just copied into the backup table, and it requires
  `status = 'archived' AND archived_at IS NULL`.
- It runs `LOCK TABLE academies IN SHARE ROW EXCLUSIVE MODE` (writers wait for
  milliseconds) and sets `lock_timeout = 10s`. It runs in one transaction. If the backed-up
  and stamped counts differ, or a postcondition fails, it raises and rolls back.
- It writes **only** `archived_at`. `status`, `updated_at`, the reason and feedback, every
  other column, and every other row are untouched.
- It deletes nothing, releases no domain, drops no cache, recomputes no usage, touches no
  media, enqueues nothing and writes no audit row. No application code runs.
- It is idempotent. A second run matches nothing and writes nothing, which the test proves.

### How it reaches production

Only through the protected deploy path: the `Deploy` workflow with `apply_migrations=true`,
which needs approval of the protected environment, then `deploy.sh --with-migrations`.
`deploy.sh` (`set -euo pipefail`, line 66) handles a pending migration as follows:

- It refuses to migrate without `--with-migrations` (lines 990-999).
- Before any schema change it runs `bash "$ATLAS_DIR/backup.sh"` (lines 1001-1005).
  `backup.sh` exits non-zero on a truncated, unreadable or incomplete dump (gzip test,
  completion marker, core tables: `backup.sh` lines 53-86), so `set -e` aborts the deploy
  before `prisma migrate deploy` (lines 1016-1023, `DATABASE_URL` = the superuser connection).
- It records pre-migration counts (line 1006).

## 5. Before / after: Release verify

Run the `Release verify` workflow (read-only, on the VPS) **before** the deploy and **after** it. Read the
`== Legacy academy archived_at backfill (OD-18; counts only, never gating)` section. It is INFO only and never fails
a run.

| Line | Before (expected) | After (expected) |
|---|---|---|
| `eligible for the backfill=N (… audit row=A, … users.deleted_at=B)` | N = the rows the migration will stamp | `0` |
| `ambiguous, never changed=M (…)` | M | **same M**. These need a manual decision |
| `archived_at already recorded=R (owner deleted=Rd)` | R | `R + N` (`Rd + N`) |
| `archived without archived_at under a live owner (out of scope)=L` | L | same L |
| `live academies of deleted owners=P` | P (expected 0) | same P |
| `eligible academies hold media assets=X, a connected custom hostname=H` | X, H | `0, 0` (they are no longer "eligible") |
| `FLAG_MEDIA_ARCHIVE_PURGE_MODE=` | current mode | current mode |
| `backfill: migration … absent (nothing stamped yet)` | present | (replaced by the next two lines) |
| `backfill: migration applied; academies stamped=S (runs=1, still carrying the stamp=S); media grace ends no earlier than YYYY-MM-DD` | — | **S = N from "before"**; the date = deploy date + 30 days |
| `backfill: media assets of stamped academies present=X, tombstoned=T` | — | X as before, **T = 0** until the grace date |

Stop and investigate in either of these cases:

- "after" stamped ≠ "before" eligible. A deletion between the two runs can only add
  "already recorded" rows, never eligible ones.
- `tombstoned` > 0 before the grace date.

Other read-only consumers: the Release verify "academies with a favicon" count filters
on `archived_at IS NULL`, so it can drop by the number of stamped academies that had a
favicon. That is expected.

**H > 0** means legacy academies still hold a connected custom hostname, which the old
path never released. This migration does not release it, by design. Release it through
the domain tooling, as a separate decision.

## 6. Rollback

The migration keeps an in-database record that outlives the 14-day backup retention. It
lives in `atlas_migration_backups.legacy_academy_archived_at_backfill`. The schema is
outside Prisma's drift check, the table is FORCE RLS with no policies, and `atlas_app` has
no grant, so only the migration superuser can read it. Each row holds: `academy_id`,
`organization_id`, `owner_user_id`, `previous_status`, `previous_archived_at` (NULL),
`previous_archive_reason` (NULL), `academy_updated_at`, `deletion_at`, `deletion_source`,
`applied_archived_at` and `run_at`.

**Revert**: as the migration superuser, run the same statement the migration header documents and the e2e test executes:

```sql
UPDATE "academies" a
   SET "archived_at" = b."previous_archived_at"
  FROM atlas_migration_backups.legacy_academy_archived_at_backfill b
 WHERE b."academy_id" = a."id"
   AND a."archived_at" = b."applied_archived_at";
```

It only touches rows still carrying the stamped value, so a row archived again since
then is left alone. `status` and `updated_at` were never changed, so there is nothing
else to restore. Do this **before the grace date** (§5). After that, purged media cannot
be brought back by any rollback.

**Last resort**: restore the verified dump `deploy.sh` took right before the migration
(`/opt/atlas/backups/atlas-<timestamp>.sql.gz`, also off-server in R2). It is kept for
14 days, and restoring it also rolls back every other write since the deploy.

`_prisma_migrations` keeps the migration recorded after a revert, so it is not re-applied.
If it is re-applied deliberately, it stamps again under a new `run_at`.

Drop the backup table only after the grace date has passed and the owner has accepted
the result:
`DROP TABLE atlas_migration_backups.legacy_academy_archived_at_backfill;`

## 7. Expected purge timing

The purge engine is `ArchivedMediaPurgeService`, with constants in
`src/retention/queue/video-retention.types.ts`. Its sweep runs every 6 hours
(`MEDIA_PURGE_SWEEP_INTERVAL_MS`) and takes up to 500 assets per tick. A media asset of
an archived academy is purged only when all three hold, re-checked at execution:

- `archived_at <= now − 30 days`;
- the organization has no legal hold and no open support case;
- `FLAG_MEDIA_ARCHIVE_PURGE_MODE=on`. The default is `dry_run`, which only logs.

For the stamped academies, with `archived_at` = migration instant T:

- **T to T+30 days.** Nothing is eligible, and the backfill itself queues nothing.
- **First sweep after T+30 days (at most 6 hours later).**
  - Mode `on`: their media is enqueued and destroyed: R2 public and protected objects,
    and hosted video with proof of absence. The rows become `deleted` tombstones with a
    `media.asset.purged` audit entry.
  - Mode `dry_run`: the sweep logs the candidates and destroys nothing.
  - Mode `off`: nothing happens.
- **Held organizations.** Never purged while the hold stands.

The alternative of stamping D (rejected) would make every row with D older than 30 days
eligible at the first sweep after the deploy, at most 6 hours later in mode `on`. The
e2e test pins both facts: not eligible now, and not eligible at T+29 days; eligible at
T+30 days; a back-dated D would be eligible today.

The ambiguous and out-of-scope rows keep `archived_at IS NULL`, so their media is still
never purged. That direction is safe, but the media is kept indefinitely. The owner
needs to decide on those rows (OD-18).
