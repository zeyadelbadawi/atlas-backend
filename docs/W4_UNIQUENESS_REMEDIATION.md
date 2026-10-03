# W4 — Name uniqueness: rollout, duplicate remediation and recovery

Organization names, academy names and learner names within an academy are
unique as of the W4 migrations. This runbook covers what the migrations do,
how to report duplicates before running them, the exact rename mapping, and
how to undo the rename from the backup tables.

## 1. The rules (product defaults; each one is a single place to change)

| Entity | Scope | Where it is enforced |
|---|---|---|
| Organization `name` | platform-wide, every status | `organizations_name_key_key` (unique), `organization_name_taken()` |
| Academy `name` | platform-wide, every status, archived included (like slugs) | `academies_name_key_key` (unique), `academy_name_taken()` |
| Learner name (`users.name`) | per academy, non-exempt rows only | `academy_students_academy_id_name_key_key` (partial unique), `academy_learner_name_taken()` |

Names compare by `atlas_name_key(name)`: NFKD, strip Latin accents, Arabic
harakat and hamza marks, superscript alef, Quranic marks, tatweel, zero-width
and bidi controls; ICU lowercase; ς→σ; NFKC; collapse whitespace. ى/ي, ة/ه,
Arabic-Indic digits and punctuation are deliberately NOT folded. A name whose
key is empty is refused with 400 `errors.validation.nameInvalid`.

Changing a default:

- archived academies release their name: add `WHERE status <> 'archived'` to
  `academies_name_key_key` and to `academy_name_taken()`, and re-check the name
  when an academy is restored.
- per-organization academy names: key the index on `(organization_id, name_key)`
  and pass the organization to `academy_name_taken()`.
- more Arabic folding: add a `translate()` to `atlas_name_key()` **and** to
  `src/common/name-uniqueness/name-key.ts` (the parity test fails otherwise), then
  run §2 again before re-creating the indexes (the stored keys change).

Learners are never renamed. Interactive admissions (registration, academy
join, staff add) get a 409 the person can act on. Automatic admissions
(sign-in auto-join, purchase/payment application) never fail: the row is
inserted with `name_unique_exempt = true` and an
`academy.student.name_clash_exempted` audit entry is written. A profile rename
that clashes in any of the user's academies is refused with
`errors.profile.nameTakenInAcademy`, listing only the user's own academies.

## 2. Migrations

| Migration | What it does | Data change |
|---|---|---|
| `20261104000300_w4_name_key_foundation` (M1) | ICU precheck, `atlas_name_key()`, generated `name_key` on organizations/academies, `academy_students.name_key` + `name_unique_exempt` (backfilled), SECURITY DEFINER triggers and boolean checks | additive |
| `20261104000310_w4_duplicate_name_remediation` (M2) | **gated** rename of duplicate org/academy names, learner exemptions, backups | renames `name` only |
| `20261104000320_w4_name_unique_indexes` (M3) | refuses if duplicates remain, then creates the three unique indexes | none |
| `20261104000330_w4_backups_out_of_public` (M4) | moves the backup tables to `atlas_migration_backups` (outside Prisma's drift check, like W8) | none |

Before deploying, confirm the ICU collation exists in the target database:

```sql
SELECT 1 FROM pg_collation WHERE collname = 'und-x-icu';  -- must return a row
```

M1 refuses to run without it, and refuses if the migrating role is neither
SUPERUSER nor BYPASSRLS.

### The gate

M2 renames customer-visible names, so it RAISES (and the deploy stops at the
migration gate, previous release intact) when any organization or academy
would be renamed, unless the operator opted in for this deployment:

```sql
ALTER DATABASE <db> SET atlas.w4_rename_duplicates = 'on';
-- npx prisma migrate deploy
ALTER DATABASE <db> RESET atlas.w4_rename_duplicates;
```

With no duplicates (a fresh database, CI) M2 is a no-op and needs no opt-in.
Learner exemptions change nothing anyone sees and need no opt-in.

If a deploy stopped at the gate, Prisma records M2 as failed. After review:
`npx prisma migrate resolve --rolled-back 20261104000310_w4_duplicate_name_remediation`,
set the opt-in, and deploy again. (M2 runs in one transaction; a refusal
leaves nothing half-done.)

## 3. Before the run: the duplicate report

Run on a read replica or snapshot. This version needs nothing installed (the
key expression is inlined), so it works before M1:

```sql
WITH k AS (
  SELECT 'organization' AS entity, id, name, created_at,
         btrim(regexp_replace(normalize(translate(lower(regexp_replace(normalize(name, NFKD),
           '[̀-ًͯ-ٰٟۖ-ۭـ​-‏‪-‮⁠-⁩﻿]', '', 'g')
           COLLATE "und-x-icu"), 'ς', 'σ'), NFKC), '\s+', ' ', 'g')) AS name_key
    FROM organizations
  UNION ALL
  SELECT 'academy', id, name, created_at,
         btrim(regexp_replace(normalize(translate(lower(regexp_replace(normalize(name, NFKD),
           '[̀-ًͯ-ٰٟۖ-ۭـ​-‏‪-‮⁠-⁩﻿]', '', 'g')
           COLLATE "und-x-icu"), 'ς', 'σ'), NFKC), '\s+', ' ', 'g'))
    FROM academies
)
SELECT entity, count(*) AS dup_groups, sum(n) AS rows_in_groups, sum(n - 1) AS rows_to_rename
  FROM (SELECT entity, name_key, count(*) n FROM k GROUP BY 1, 2 HAVING count(*) > 1) g
 GROUP BY entity;
```

Per-row listing after M1 (`name_key` exists). `rn = 1` keeps its name; every
other row is renamed:

```sql
SELECT 'organization' AS entity, name_key, id, name, status, created_at,
       row_number() OVER (PARTITION BY name_key ORDER BY created_at, id) AS rn
  FROM organizations
 WHERE name_key IN (SELECT name_key FROM organizations GROUP BY 1 HAVING count(*) > 1)
UNION ALL
SELECT 'academy', name_key, id, name, status::text, created_at,
       row_number() OVER (PARTITION BY name_key ORDER BY created_at, id)
  FROM academies
 WHERE name_key IN (SELECT name_key FROM academies GROUP BY 1 HAVING count(*) > 1)
ORDER BY 1, 2, 7;

-- learners that would be exempted (never renamed)
SELECT academy_id, name_key, id, user_id, joined_at,
       row_number() OVER (PARTITION BY academy_id, name_key ORDER BY joined_at, id) AS rn
  FROM academy_students
 WHERE NOT name_unique_exempt
   AND (academy_id, name_key) IN (
     SELECT academy_id, name_key FROM academy_students WHERE NOT name_unique_exempt
      GROUP BY 1, 2 HAVING count(*) > 1)
ORDER BY 1, 2, 6;
```

## 4. The exact mapping

For each group of rows sharing a `name_key`, in fixed `(created_at, id)` order:

- the oldest row keeps its name;
- row number `n` (2, 3, …) becomes `left(rtrim(name), L - length(' (n)')) || ' (n)'`,
  where `L` is the API limit (organizations 120, academies 100 characters);
- if that suffixed name's key is already taken (a real "Acme (2)" exists, or a
  previous rename took it), `n` keeps increasing until the key is free;
- only `name` changes — never `id` or `slug`, so foreign keys, subdomains and
  URLs are untouched;
- learners: rows `n ≥ 2` of a group inside one academy get
  `name_unique_exempt = true` (ordered by `joined_at, id`).

To see the exact mapping before committing, after M1 is applied, run M2 in a
rolled-back transaction:

```sql
BEGIN;
SET LOCAL atlas.w4_rename_duplicates = 'on';
\i prisma/migrations/20261104000310_w4_duplicate_name_remediation/migration.sql
SELECT name AS old_name, new_name, group_rank FROM public.w4_backup_organization_names ORDER BY name_key, group_rank;
SELECT name AS old_name, new_name, group_rank FROM public.w4_backup_academy_names ORDER BY name_key, group_rank;
SELECT * FROM public.w4_backup_academy_student_exemptions;
ROLLBACK;
```

After the real run, the mapping is the backup tables (no SQL-level audit
writer exists: audit rows need an acting user, so the backup tables are the
record):

```sql
SELECT id, name AS old_name, new_name, name_key, group_rank, run_at
  FROM atlas_migration_backups.w4_backup_organization_names ORDER BY run_at, name_key, group_rank;
SELECT id, name AS old_name, new_name, name_key, group_rank, run_at
  FROM atlas_migration_backups.w4_backup_academy_names ORDER BY run_at, name_key, group_rank;
SELECT * FROM atlas_migration_backups.w4_backup_academy_student_exemptions ORDER BY run_at;
```

After the run: the public site caches the academy name with its hostname
resolution for 60 seconds, so renamed academies show their new name within a
minute. Tell the owners of renamed organizations and academies; they can
rename from the dashboard.

Local run (disposable e2e database, 3 Oct 2026): before — organizations 558
duplicate groups / 1,653 rows / 1,095 to rename; academies 426 / 1,246 / 820;
learners 0. After — 0 / 0 / 0; backups hold 1,095 organization and 820 academy
mappings under one `run_at`.

## 5. Recovery: restoring the original names

Tested locally: it restored all 1,095 organization and 820 academy names, and
the duplicate counts went back to exactly the pre-run figures. The learner
step was tested on a synthetic duplicate. Run as the migration role:

```sql
-- psql -v ON_ERROR_STOP=1 -f recovery.sql   (optionally -v run_at='2026-10-03 18:00:47+00')
\if :{?run_at}
\else
  SELECT max(run_at) AS run_at FROM atlas_migration_backups.w4_backup_organization_names \gset
\endif
BEGIN;
SET LOCAL lock_timeout = '10s';

-- 1. M3's unique indexes would refuse the restored duplicates.
DROP INDEX IF EXISTS "organizations_name_key_key";
DROP INDEX IF EXISTS "academies_name_key_key";
DROP INDEX IF EXISTS "academy_students_academy_id_name_key_key";

-- 2. Names: only rows that still hold the value M2 wrote, so an owner's
--    later rename is never overwritten. Ids and slugs were never changed.
UPDATE "organizations" o
   SET "name" = b."name"
  FROM atlas_migration_backups.w4_backup_organization_names b
 WHERE b."id" = o."id"
   AND b."run_at" = :'run_at'::timestamptz
   AND o."name" = b."new_name";

UPDATE "academies" a
   SET "name" = b."name"
  FROM atlas_migration_backups.w4_backup_academy_names b
 WHERE b."id" = a."id"
   AND b."run_at" = :'run_at'::timestamptz
   AND a."name" = b."new_name";

-- 3. Learner exemptions back to their previous value.
UPDATE "academy_students" s
   SET "name_unique_exempt" = b."previous_exempt"
  FROM atlas_migration_backups.w4_backup_academy_student_exemptions b
 WHERE b."id" = s."id"
   AND b."run_at" = :'run_at'::timestamptz;

COMMIT;
```

With the indexes gone, the application still refuses new duplicates (its
advisory-locked definer checks), but scripts and seeds are no longer
constrained. To restore the constraint later, fix the duplicates and run the
body of M3 by hand. It is already recorded as applied, so `migrate deploy`
will not run it again.

Full rollback of W4 (only if abandoning the feature): run the recovery above,
then the reversal block in M1's header.

## 6. Retention and upkeep

- Keep the backup tables for one release, then drop them through a reviewed
  migration (statement in M4's header).
- `atlas_name_key()` depends on ICU case mapping and Unicode normalization.
  After a PostgreSQL major or OS/ICU image upgrade, run
  `REINDEX INDEX organizations_name_key_key;`, `REINDEX INDEX academies_name_key_key;`
  and `REINDEX INDEX academy_students_academy_id_name_key_key;`, then §3's report. Characters added in a newer Unicode version than the
  server's ICU may key differently in the TypeScript mirror (9 code points in
  the BMP did on 3 Oct 2026). The mirror is used only for form messages, so
  the database decides.
