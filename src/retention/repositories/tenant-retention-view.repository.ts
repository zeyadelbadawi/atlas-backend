/**
 * The READ side of hosted-video retention — everything the owner-facing
 * `/dashboard/tenant/retention` page needs, and nothing that decides
 * anything.
 *
 * A SEPARATE FILE FROM `VideoRetentionRepository` ON PURPOSE.
 * That repository is the deletion path: its queries feed the evaluator
 * that destroys bytes. This one is a window onto the same rows for the
 * customer whose bytes they are. Keeping them apart means a change made
 * for the page can never alter what the sweep sees — the reviewer does
 * not have to work out which of two dozen methods the destructive branch
 * happens to call.
 *
 * IT REUSES RATHER THAN RESTATES. `retentionAssetFilter()` defines what
 * "hosted video subject to retention" means in exactly one place; if the
 * page counted assets with its own `where` clause it would eventually
 * tell an owner a different number from the one the warning email
 * quotes. Guard (2)'s evidence is read through
 * `VideoRetentionRepository.findWarningsSent` for the same reason.
 *
 * CONTEXT. Every method takes the caller's `tx`, which the service opens
 * with `runInTenantAndUserContext(organizationId, callerUserId)`:
 *
 *   - `media_assets`, `courses`, `tenant_lifecycle_state` and
 *     `communication_outbox` are all reachable by the ORGANISATION GUC
 *     (`media_assets_tenant_select`, `courses_tenant_select`,
 *     `tenant_lifecycle_state_tenant_select`,
 *     `communication_outbox_tenant_select`). A caller from another
 *     organisation gets zero rows from the database even if every guard
 *     above were removed.
 *   - `support_cases` has NO tenant-scoped SELECT policy — only
 *     `support_cases_platform_select` and `support_cases_requester_select`
 *     — so the USER GUC is what lets an owner see a hold caused by a case
 *     they themselves opened. See the service for what that means and why
 *     the residue is safe.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { retentionAssetFilter } from './video-retention.repository';

/** Per-course rollup of the hosted video subject to retention. */
export interface TenantRetentionCourseTally {
  readonly id: string;
  readonly title: string;
  readonly videoCount: number;
  readonly totalSeconds: number;
}

export interface TenantRetentionAssetTally {
  readonly assetCount: number;
  readonly totalBytes: bigint;
  readonly totalSeconds: number;
  /** Capped at the caller's `maxCourses`, most-affected first. */
  readonly courses: readonly TenantRetentionCourseTally[];
  /** How many courses are affected IN TOTAL, before the cap. */
  readonly affectedCourseCount: number;
  /** Assets with no course yet (library uploads) — counted, never attributed. */
  readonly unassignedCount: number;
}

/** What retention has ALREADY taken from this organisation. */
export interface TenantRetentionTombstoneTally {
  readonly deletedAssetCount: number;
  readonly lastDeletedAt: Date | null;
}

/**
 * The prefix `VideoRetentionDeletionService` writes into
 * `media_assets.deletion_reason` (`retention_trial` / `retention_paid`).
 *
 * Matching on it rather than on `status: 'deleted'` alone matters: an
 * asset a Manager deleted by hand is also a tombstone, and telling an
 * owner that retention took a video they removed themselves would be
 * false in the one direction this page must never be false in.
 */
const RETENTION_DELETION_REASON_PREFIX = 'retention_';

@Injectable()
export class TenantRetentionViewRepository {
  /**
   * Everything the page says about "what will be deleted", in one pass.
   *
   * Course titles are resolved in a second query rather than through an
   * `include`, because the asset rows are counted per course here and a
   * joined title would be repeated on every row.
   */
  async assetTally(
    tx: Prisma.TransactionClient,
    organizationId: string,
    maxCourses: number,
  ): Promise<TenantRetentionAssetTally> {
    const assets = await tx.mediaAsset.findMany({
      where: { ...retentionAssetFilter(), academy: { organizationId } },
      select: { sizeBytes: true, durationSeconds: true, courseId: true },
    });

    let totalBytes = 0n;
    let totalSeconds = 0;
    let unassignedCount = 0;
    const perCourse = new Map<string, { videoCount: number; totalSeconds: number }>();

    for (const asset of assets) {
      totalBytes += asset.sizeBytes;
      const seconds = asset.durationSeconds ?? 0;
      totalSeconds += seconds;
      if (!asset.courseId) {
        unassignedCount++;
        continue;
      }
      const row = perCourse.get(asset.courseId) ?? { videoCount: 0, totalSeconds: 0 };
      row.videoCount++;
      row.totalSeconds += seconds;
      perCourse.set(asset.courseId, row);
    }

    const titles = perCourse.size
      ? await tx.course.findMany({
          where: { id: { in: [...perCourse.keys()] } },
          select: { id: true, title: true },
        })
      : [];
    const titleById = new Map(titles.map((course) => [course.id, course.title]));

    const courses: TenantRetentionCourseTally[] = [...perCourse.entries()]
      .map(([id, row]) => ({
        id,
        // A course row RLS did not return is not invented a title for; the
        // id is the honest answer and the page renders it as "untitled".
        title: titleById.get(id) ?? '',
        videoCount: row.videoCount,
        totalSeconds: row.totalSeconds,
      }))
      // Most affected first — the course an owner most wants to save is
      // the one with the most video in it.
      .sort((a, b) => b.videoCount - a.videoCount || a.title.localeCompare(b.title));

    return {
      assetCount: assets.length,
      totalBytes,
      totalSeconds,
      courses: courses.slice(0, maxCourses),
      affectedCourseCount: courses.length,
      unassignedCount,
    };
  }

  /**
   * Retention tombstones — the rows this automation has already written.
   *
   * `status: 'deleted'` AND a retention `deletionReason`, never one
   * without the other.
   */
  async tombstoneTally(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<TenantRetentionTombstoneTally> {
    const rows = await tx.mediaAsset.findMany({
      where: {
        type: 'video',
        status: 'deleted',
        deletionReason: { startsWith: RETENTION_DELETION_REASON_PREFIX },
        academy: { organizationId },
      },
      select: { deletedAt: true },
      orderBy: { deletedAt: 'desc' },
    });
    return {
      deletedAssetCount: rows.length,
      lastDeletedAt: rows.find((row) => row.deletedAt !== null)?.deletedAt ?? null,
    };
  }

  /** The hold flag C6 writes and C5 never touches. Null when no row exists yet. */
  findLifecycleState(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<{
    legalHold: boolean;
    holdReason: string | null;
    deletionScheduledAt: Date | null;
  } | null> {
    return tx.tenantLifecycleState.findUnique({
      where: { organizationId },
      select: { legalHold: true, holdReason: true, deletionScheduledAt: true },
    });
  }
}
