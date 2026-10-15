/**
 * OD-18 (B0-SEC-15 follow-up) — the legacy academy `archived_at` backfill,
 * migration 20261118000100, against real Postgres.
 *
 * Fixtures reproduce what the pre-D5-2 account-deletion path wrote (a bare
 * `status = 'archived'` updateMany — `updated_at` bumped, nothing else —
 * then the owner anonymised and an `account.deleted*` audit row), next to
 * every row the backfill must leave alone. The migration file itself is
 * then executed (`prisma db execute`, the same script `migrate deploy`
 * runs), and the Release-verify diagnostic (`LEGACY_ARCHIVE_SQL`, read out
 * of deploy/release-verify/remote.sh verbatim) is run before and after.
 *
 * Asserted: only eligible rows change, and only `archived_at`, all to the
 * run instant; the evidence lands in the backup table; a second run
 * changes nothing; the SQL helpers now treat the rows as archived; nothing
 * is deleted (rows, media rows, stored bytes, domain connection); no media
 * becomes purge-eligible until 30 days after the run.
 */
import { INestApplication } from '@nestjs/common';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyStudent,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import {
  ArchivedMediaPurgeService,
  isPurgeEligible,
} from '../src/retention/services/archived-media-purge.service';
import {
  MEDIA_STORAGE_PROVIDER,
  type MediaStorageProvider,
} from '../src/media/storage/media-storage.interface';

const DAY = 24 * 60 * 60 * 1000;
const MIGRATION = resolve(
  __dirname,
  '../prisma/migrations/20261118000100_legacy_academy_archived_at_backfill/migration.sql',
);
const BACKUP = 'atlas_migration_backups.legacy_academy_archived_at_backfill';

const REMOTE = readFileSync(
  join(__dirname, '../deploy/release-verify/remote.sh'),
  'utf8',
);
const DIAGNOSTIC_SQL = /LEGACY_ARCHIVE_SQL=\$\(cat <<'SQL'\n([\s\S]*?)\nSQL\n\)/.exec(
  REMOTE,
)?.[1];

const COUNT_NAMES = [
  'eligible',
  'eligibleAudited',
  'eligibleDeletedAt',
  'ambiguousOwnerMarker',
  'ambiguousNormalArchive',
  'ambiguousWindow',
  'recorded',
  'recordedDeletedOwner',
  'legacyLiveOwner',
  'liveDeletedOwner',
  'eligibleMedia',
  'eligibleHostnames',
] as const;
type Counts = Record<(typeof COUNT_NAMES)[number], number>;

describe('Legacy academy archived_at backfill — migration 20261118000100 (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let purge: ArchivedMediaPurgeService;
  let publicStorage: MediaStorageProvider;
  let platformOwnerId: string;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    admin = createAdminPrisma();
    purge = app.get(ArchivedMediaPurgeService);
    publicStorage = app.get(MEDIA_STORAGE_PROVIDER);
    const po = await admin.user.create({
      data: {
        email: `legacy-po-${randomUUID()}@example.test`,
        name: 'legacy-po',
        isPlatformOwner: true,
      },
    });
    platformOwnerId = po.id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  /** Runs the migration file exactly as written, as the migration superuser. */
  function runMigration(): void {
    const result = spawnSync(
      'npx',
      [
        'prisma',
        'db',
        'execute',
        '--file',
        MIGRATION,
        '--schema',
        'prisma/schema.prisma',
      ],
      { cwd: resolve(__dirname, '..'), encoding: 'utf8', env: process.env },
    );
    if (result.status !== 0) {
      throw new Error(`migration failed: ${result.stdout}\n${result.stderr}`);
    }
  }

  async function diagnostic(): Promise<Counts> {
    if (!DIAGNOSTIC_SQL) throw new Error('LEGACY_ARCHIVE_SQL not found in remote.sh');
    const rows = await admin.$queryRawUnsafe<{ row: string }[]>(
      `SELECT t::text AS row FROM (${DIAGNOSTIC_SQL}) t`,
    );
    const [tag, ...values] = rows[0].row.replace(/^\(|\)$/g, '').split(',');
    expect(tag).toBe('legacyarchive');
    return Object.fromEntries(
      COUNT_NAMES.map((name, i) => [name, Number(values[i])]),
    ) as Counts;
  }

  const delta = (after: Counts, before: Counts) =>
    Object.fromEntries(COUNT_NAMES.map((n) => [n, after[n] - before[n]])) as Counts;

  /** Every academy row, as JSON (the generated tsvector left out). */
  async function snapshot(): Promise<Map<string, Record<string, unknown>>> {
    const rows = await admin.$queryRaw<{ id: string; j: Record<string, unknown> }[]>`
      SELECT a.id, to_jsonb(a) - 'search_vector' AS j FROM academies a`;
    return new Map(rows.map((r) => [r.id, r.j]));
  }

  async function backupRows(): Promise<
    {
      academy_id: string;
      deletion_source: string;
      deletion_at: Date;
      academy_updated_at: Date;
      previous_status: string;
      previous_archived_at: Date | null;
      applied_archived_at: Date;
      run_at: Date;
    }[]
  > {
    return admin.$queryRawUnsafe(`SELECT * FROM ${BACKUP} ORDER BY run_at, academy_id`);
  }

  const setUpdatedAt = (academyId: string, at: Date) =>
    admin.$executeRaw`UPDATE academies SET updated_at = (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC') WHERE id = ${academyId}`;

  /** An owner, their organization and `academyCount` live academies. */
  async function tenant(label: string, academyCount = 1) {
    const owner = await admin.user.create({
      data: { email: `${label}-${randomUUID()}@example.test`, name: label },
    });
    const org = await seedOrganizationWithOwner(admin, owner.id, label);
    const academies = [];
    for (let i = 0; i < academyCount; i += 1) {
      academies.push(await seedAcademy(admin, org.id, `${label}-${i}`));
    }
    return { owner, org, academies };
  }

  /**
   * What `archiveOwnedAcademies` did before 4cd7460 — the same Prisma call —
   * then the anonymisation's two markers, all dated `deletedAt`.
   */
  async function oldPathDeletion(
    t: Awaited<ReturnType<typeof tenant>>,
    deletedAt: Date,
    options: {
      audit?: 'account.deleted' | 'account.deleted_by_platform_owner' | null;
      statusDeleted?: boolean;
      deletedAtMarker?: boolean;
      archiveSecondsBefore?: number;
    } = {},
  ) {
    const longBefore = new Date(Date.now() - 400 * DAY);
    for (const academy of t.academies) await setUpdatedAt(academy.id, longBefore);
    const writeStartedAt = Date.now();
    const result = await admin.academy.updateMany({
      where: { organizationId: t.org.id, status: { not: 'archived' } },
      data: { status: 'archived' },
    });
    expect(result.count).toBe(t.academies.length);
    // Evidence the eligibility rule relies on: the old write stamped
    // `updated_at` (Prisma `@updatedAt` applies to updateMany too) and wrote
    // nothing else archive-related.
    for (const academy of t.academies) {
      const row = await admin.academy.findUniqueOrThrow({ where: { id: academy.id } });
      expect(row.status).toBe('archived');
      expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(writeStartedAt - 5_000);
      expect(row.archivedAt).toBeNull();
      expect(row.archiveReason).toBeNull();
      expect(row.archiveFeedback).toBeNull();
    }
    // Re-dated into the past, as production rows are: the archive write a
    // few seconds before the anonymisation.
    const archivedAt = new Date(
      deletedAt.getTime() - (options.archiveSecondsBefore ?? 3) * 1000,
    );
    for (const academy of t.academies) await setUpdatedAt(academy.id, archivedAt);
    await admin.user.update({
      where: { id: t.owner.id },
      data: {
        email: `deleted-${randomUUID()}@account.invalid`,
        name: 'Deleted account',
        status: options.statusDeleted === false ? 'active' : 'deleted',
        deletedAt: options.deletedAtMarker === false ? null : deletedAt,
      },
    });
    const audit = options.audit === undefined ? 'account.deleted' : options.audit;
    if (audit) {
      await admin.auditLogEntry.create({
        data: {
          actorUserId: audit === 'account.deleted' ? t.owner.id : platformOwnerId,
          action: audit,
          targetType: 'user',
          targetId: t.owner.id,
          occurredAt: new Date(deletedAt.getTime() - 1000),
        },
      });
    }
  }

  async function publicAsset(academyId: string) {
    const key = `academies/${academyId}/legacy-${randomUUID()}.png`;
    await publicStorage.putObject(key, Buffer.from('png'), 'image/png');
    return admin.mediaAsset.create({
      data: {
        academyId,
        type: 'image',
        status: 'active',
        fileName: 'logo.png',
        storageKey: key,
        url: '',
        mimeType: 'image/png',
        sizeBytes: BigInt(3),
        access: 'public',
        provider: 'r2',
      },
    });
  }

  it('stamps only legacy rows from the old deletion path, records the evidence, and is idempotent; nothing is deleted or purged', async () => {
    const baseline = await diagnostic();
    const longAgo = new Date(Date.now() - 45 * DAY);
    const fortyDays = new Date(Date.now() - 40 * DAY);

    // --- rows that must NOT change -----------------------------------------
    const live = await tenant('legacy-live');
    const normal = await tenant('legacy-normal');
    await admin.academy.update({
      where: { id: normal.academies[0].id },
      data: {
        status: 'archived',
        archivedAt: new Date(Date.now() - 50 * DAY),
        archiveReason: 'no_longer_needed',
      },
    });
    await admin.auditLogEntry.create({
      data: {
        actorUserId: normal.owner.id,
        organizationId: normal.org.id,
        academyId: normal.academies[0].id,
        action: 'academy.archived',
        targetType: 'academy',
        targetId: normal.academies[0].id,
      },
    });
    // An owner's own Delete before `archived_at` existed: owner still live.
    const ownerArchivedLegacy = await tenant('legacy-live-owner');
    await admin.academy.update({
      where: { id: ownerArchivedLegacy.academies[0].id },
      data: { status: 'archived' },
    });
    // Deleted owner, archived by the D5-2 path (archived_at already set).
    const d52 = await tenant('legacy-d52');
    await admin.academy.update({
      where: { id: d52.academies[0].id },
      data: { status: 'archived', archivedAt: new Date(Date.now() - 2 * DAY) },
    });
    await admin.user.update({
      where: { id: d52.owner.id },
      data: {
        email: `deleted-${randomUUID()}@account.invalid`,
        status: 'deleted',
        deletedAt: new Date(Date.now() - 2 * DAY),
      },
    });
    // Deleted owner whose academy is still live (never archived).
    const liveOfDeleted = await tenant('legacy-live-deleted');
    await admin.user.update({
      where: { id: liveOfDeleted.owner.id },
      data: {
        email: `deleted-${randomUUID()}@account.invalid`,
        status: 'deleted',
        deletedAt: longAgo,
      },
    });

    // --- ambiguous (owner deleted, but the evidence does not hold) --------
    const partialMarker = await tenant('legacy-partial-marker');
    await oldPathDeletion(partialMarker, longAgo, { deletedAtMarker: false });
    const withReason = await tenant('legacy-with-reason');
    await oldPathDeletion(withReason, longAgo);
    await admin.academy.update({
      where: { id: withReason.academies[0].id },
      data: { archiveReason: 'other' },
    });
    await setUpdatedAt(withReason.academies[0].id, new Date(longAgo.getTime() - 3000));
    const withAcademyAudit = await tenant('legacy-academy-audit');
    await oldPathDeletion(withAcademyAudit, longAgo);
    await admin.auditLogEntry.create({
      data: {
        actorUserId: withAcademyAudit.owner.id,
        organizationId: withAcademyAudit.org.id,
        academyId: withAcademyAudit.academies[0].id,
        action: 'academy.archived',
        targetType: 'academy',
        targetId: withAcademyAudit.academies[0].id,
      },
    });
    // Archived ten days before the deletion (not by it).
    const outsideWindow = await tenant('legacy-outside-window');
    await oldPathDeletion(outsideWindow, longAgo, { archiveSecondsBefore: 10 * 86_400 });

    // --- eligible ----------------------------------------------------------
    // Self-deleted, audited, two academies (the old path archived them all),
    // a learner, media with stored bytes, and a connected custom domain.
    const audited = await tenant('legacy-audited', 2);
    const learner = await admin.user.create({
      data: {
        email: `legacy-learner-${randomUUID()}@example.test`,
        name: 'legacy-learner',
      },
    });
    await seedAcademyStudent(admin, audited.academies[0].id, learner.id);
    await seedAcademyStudent(admin, live.academies[0].id, learner.id);
    const asset = await publicAsset(audited.academies[0].id);
    const hostname = `legacy-${randomUUID().slice(0, 8)}.example.test`;
    await admin.domainConnection.create({
      data: { academyId: audited.academies[1].id, hostname, status: 'connected' },
    });
    // The helpers' view BEFORE the deletion and before the backfill.
    await oldPathDeletion(audited, longAgo);
    // Deleted by a Platform Owner.
    const byOperator = await tenant('legacy-by-operator');
    await oldPathDeletion(byOperator, fortyDays, {
      audit: 'account.deleted_by_platform_owner',
    });
    // The best-effort audit row was never written: dated by users.deleted_at.
    const noAudit = await tenant('legacy-no-audit');
    await oldPathDeletion(noAudit, fortyDays, { audit: null });

    const eligibleIds = [
      ...audited.academies.map((a) => a.id),
      byOperator.academies[0].id,
      noAudit.academies[0].id,
    ];
    const untouchedIds = [
      live.academies[0].id,
      normal.academies[0].id,
      ownerArchivedLegacy.academies[0].id,
      d52.academies[0].id,
      liveOfDeleted.academies[0].id,
      partialMarker.academies[0].id,
      withReason.academies[0].id,
      withAcademyAudit.academies[0].id,
      outsideWindow.academies[0].id,
    ];

    // --- the diagnostic, before -------------------------------------------
    const before = await diagnostic();
    expect(delta(before, baseline)).toEqual({
      eligible: 4,
      eligibleAudited: 3,
      eligibleDeletedAt: 1,
      ambiguousOwnerMarker: 1,
      ambiguousNormalArchive: 2,
      ambiguousWindow: 1,
      recorded: 2,
      recordedDeletedOwner: 1,
      legacyLiveOwner: 1,
      liveDeletedOwner: 1,
      eligibleMedia: 1,
      eligibleHostnames: 1,
    });

    // Legacy rows read as LIVE to the helpers (the defect).
    const learnerAcademies = async () =>
      (
        await admin.$queryRaw<{ academy_id: string }[]>`
          SELECT academy_id FROM resolve_learner_academies(${learner.id})`
      ).map((r) => r.academy_id);
    const registrationPolicy = async (academyId: string) =>
      (
        await admin.$queryRaw<{ policy: string | null }[]>`
          SELECT resolve_academy_registration_policy(${academyId})::text AS policy`
      )[0].policy;
    expect(await learnerAcademies()).toEqual(
      expect.arrayContaining([audited.academies[0].id, live.academies[0].id]),
    );
    expect(await registrationPolicy(audited.academies[0].id)).toBe('open');

    const counts = async () => ({
      academies: await admin.academy.count(),
      media: await admin.mediaAsset.count(),
      mediaDeleted: await admin.mediaAsset.count({ where: { status: 'deleted' } }),
      domains: await admin.domainConnection.count(),
      audit: await admin.auditLogEntry.count(),
    });
    const countsBefore = await counts();
    const snapBefore = await snapshot();
    const backupBefore = await backupRows();
    const runStartedAt = Date.now();

    runMigration();

    // --- exactly the eligible rows changed, and only archived_at ----------
    const snapAfter = await snapshot();
    const backupAfter = await backupRows();
    const newBackup = backupAfter.slice(backupBefore.length);
    // Everything the diagnostic called eligible — including any leftover
    // legacy rows other suites left in this shared database — and nothing else.
    expect(newBackup).toHaveLength(before.eligible);
    const stamped = new Set(newBackup.map((b) => b.academy_id));
    for (const id of eligibleIds) expect(stamped.has(id)).toBe(true);
    for (const id of untouchedIds) expect(stamped.has(id)).toBe(false);

    const applied = newBackup[0].applied_archived_at;
    expect(applied.getTime()).toBeGreaterThanOrEqual(runStartedAt - 60_000);
    expect(applied.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
    for (const [id, row] of snapBefore) {
      const after = snapAfter.get(id);
      if (stamped.has(id)) {
        const { archived_at: was, ...restBefore } = row;
        const { archived_at: now, ...restAfter } = after ?? {};
        expect(was).toBeNull();
        expect(new Date(`${String(now)}Z`).getTime()).toBe(applied.getTime());
        // status, updated_at, archive_reason/feedback, everything else: as was.
        expect(restAfter).toEqual(restBefore);
      } else {
        expect(after).toEqual(row);
      }
    }

    // --- the evidence ------------------------------------------------------
    const evidence = (id: string) => newBackup.find((b) => b.academy_id === id)!;
    expect(evidence(audited.academies[0].id)).toMatchObject({
      deletion_source: 'audit_account_deleted',
      previous_status: 'archived',
      previous_archived_at: null,
    });
    expect(evidence(audited.academies[0].id).deletion_at.getTime()).toBe(
      longAgo.getTime() - 1000,
    );
    expect(evidence(audited.academies[0].id).academy_updated_at.getTime()).toBe(
      longAgo.getTime() - 3000,
    );
    expect(evidence(byOperator.academies[0].id).deletion_source).toBe(
      'audit_account_deleted',
    );
    expect(evidence(noAudit.academies[0].id)).toMatchObject({
      deletion_source: 'user_deleted_at',
    });
    expect(evidence(noAudit.academies[0].id).deletion_at.getTime()).toBe(
      fortyDays.getTime(),
    );

    // --- the diagnostic, after --------------------------------------------
    const after = await diagnostic();
    expect(after.eligible).toBe(0);
    expect(after.eligibleMedia).toBe(0);
    expect(after.ambiguousOwnerMarker).toBe(before.ambiguousOwnerMarker);
    expect(after.ambiguousNormalArchive).toBe(before.ambiguousNormalArchive);
    expect(after.ambiguousWindow).toBe(before.ambiguousWindow);
    expect(after.legacyLiveOwner).toBe(before.legacyLiveOwner);
    expect(after.liveDeletedOwner).toBe(before.liveDeletedOwner);
    expect(after.recorded).toBe(before.recorded + before.eligible);
    expect(after.recordedDeletedOwner).toBe(
      before.recordedDeletedOwner + before.eligible,
    );

    // --- the helpers now treat them as archived ---------------------------
    const nowListed = await learnerAcademies();
    expect(nowListed).not.toContain(audited.academies[0].id);
    expect(nowListed).toContain(live.academies[0].id);
    expect(await registrationPolicy(audited.academies[0].id)).toBeNull();
    expect(await registrationPolicy(live.academies[0].id)).toBe('open');

    // --- nothing deleted, no domain released, no media touched ------------
    expect(await counts()).toEqual(countsBefore);
    const assetAfter = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: asset.id },
    });
    expect(assetAfter.status).toBe('active');
    expect(assetAfter.updatedAt).toEqual(asset.updatedAt);
    expect(await publicStorage.objectExists(asset.storageKey)).toBe(true);
    const domain = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: audited.academies[1].id },
    });
    expect(domain).toMatchObject({ hostname, status: 'connected' });

    // --- purge timing: a fresh 30-day grace from the run, not back-dated ---
    const listed = async (at: Date) =>
      (await purge.findCandidates(platformOwnerId, at)).map((c) => c.assetId);
    expect(await listed(new Date())).not.toContain(asset.id);
    expect(await listed(new Date(applied.getTime() + 29 * DAY))).not.toContain(asset.id);
    const academyState = { status: 'archived', archivedAt: applied };
    const assetState = {
      status: 'active',
      updatedAt: asset.updatedAt,
      referenced: false,
    };
    expect(isPurgeEligible({ ...assetState, academy: academyState }, new Date())).toBe(
      false,
    );
    expect(
      isPurgeEligible(
        { ...assetState, academy: academyState },
        new Date(applied.getTime() + 30 * DAY + 60_000),
      ),
    ).toBe(true);
    // Had the true deletion instant been used, it would be eligible today.
    expect(
      isPurgeEligible(
        { ...assetState, academy: { status: 'archived', archivedAt: longAgo } },
        new Date(),
      ),
    ).toBe(true);

    // --- idempotent: a second run changes nothing -------------------------
    runMigration();
    expect(await backupRows()).toHaveLength(backupAfter.length);
    expect(await snapshot()).toEqual(snapAfter);
    expect(await counts()).toEqual(countsBefore);
  });

  it('the documented rollback restores exactly the stamped rows', async () => {
    const t = await tenant('legacy-rollback');
    await oldPathDeletion(t, new Date(Date.now() - 35 * DAY));
    runMigration();
    const stampedRow = await admin.academy.findUniqueOrThrow({
      where: { id: t.academies[0].id },
    });
    expect(stampedRow.archivedAt).not.toBeNull();

    // Verbatim from the migration header / runbook.
    await admin.$executeRawUnsafe(`
      UPDATE "academies" a
         SET "archived_at" = b."previous_archived_at"
        FROM ${BACKUP} b
       WHERE b."academy_id" = a."id"
         AND a."archived_at" = b."applied_archived_at"`);
    const restored = await admin.academy.findUniqueOrThrow({
      where: { id: t.academies[0].id },
    });
    expect(restored.archivedAt).toBeNull();
    expect(restored.status).toBe('archived');
    expect(restored.updatedAt).toEqual(stampedRow.updatedAt);

    // Re-applying after a rollback stamps the row again (a new run_at).
    runMigration();
    const again = await admin.academy.findUniqueOrThrow({
      where: { id: t.academies[0].id },
    });
    expect(again.archivedAt).not.toBeNull();
  });
});
