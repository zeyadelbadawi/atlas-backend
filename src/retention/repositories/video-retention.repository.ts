/**
 * Data access for hosted-video retention — P64 Communications C6.
 *
 * Every method takes the caller's `tx`, and WHICH CONTEXT that transaction
 * is in is not incidental here — it is the difference between the
 * tombstone being written and being silently discarded:
 *
 *   - READS of `tenant_subscriptions`, `tenant_lifecycle_state`,
 *     `support_cases` and `communication_outbox` run under the PLATFORM
 *     OWNER's user context (`runInUserContext`), the cross-tenant
 *     precedent `SubscriptionExpiryService` and C5 already established.
 *   - The TOMBSTONE WRITE runs under `runInTenantAndUserContext`, because
 *     `media_assets` has a platform-owner SELECT policy
 *     (`media_assets_platform_select`) and NO platform-owner UPDATE
 *     policy. Its only UPDATE policy is `media_assets_tenant_update`,
 *     which matches on `app.current_organization_id`. An UPDATE with no
 *     matching policy does not raise — it affects zero rows — so a
 *     tombstone written under the platform context alone would appear to
 *     succeed and would not exist. Both session variables are set, which
 *     is exactly the shape `PlatformPaymentService.approvePayment`
 *     established in P12 for the same reason.
 *
 * THE CANDIDATE SCAN IS BOUNDED BY THE WINDOWS THEMSELVES, computed from
 * the evaluator's own constants via `retentionCandidateAnchorRange` rather
 * than restated, so the query and the decision can never drift. An
 * organisation whose trial lapsed two years ago is not a row this query
 * returns — which is the database-level half of the lateness horizon.
 */
import { Injectable } from '@nestjs/common';
import type { MediaAssetProvider, Prisma } from '@prisma/client';
import {
  retentionCandidateAnchorRange,
  RETENTION_WARNING_STEPS,
  type RetentionStepId,
} from '../utils/video-retention.util';

/** Everything one organisation's retention evaluation needs, in one round trip. */
export type RetentionCandidate = Prisma.TenantSubscriptionGetPayload<{
  select: {
    organizationId: true;
    status: true;
    trialEndsAt: true;
    currentPeriodEnd: true;
    graceEndsAt: true;
    cancelAtPeriodEnd: true;
    organization: {
      select: {
        id: true;
        name: true;
        status: true;
        owner: { select: { id: true; email: true; status: true; deletedAt: true } };
        cancellations: { select: { kind: true; effectiveAt: true } };
        lifecycleState: {
          select: { legalHold: true; holdReason: true; deletionScheduledAt: true };
        };
      };
    };
  };
}>;

/** One hosted-video asset eligible for deletion. */
export type RetentionAsset = Prisma.MediaAssetGetPayload<{
  select: {
    id: true;
    academyId: true;
    status: true;
    provider: true;
    providerId: true;
    storageKey: true;
    fileName: true;
    sizeBytes: true;
    durationSeconds: true;
    courseId: true;
    deletedAt: true;
    deletionFailedAt: true;
  };
}>;

export interface RetentionHold {
  readonly held: boolean;
  readonly reason: string | null;
}

export interface RetentionTally {
  readonly assetCount: number;
  readonly totalBytes: bigint;
  readonly totalMinutes: number;
  readonly courseTitles: readonly string[];
}

/**
 * §31 — what is actually deleted, expressed once.
 *
 * PROTECTED HOSTED VIDEO AND NOTHING ELSE. Not images, not documents, not
 * the public logo that defines the site, not a protected PDF. `provider`
 * is the storage fact (`r2` is the plain protected-file tier and is
 * deliberately absent), `access: 'protected'` keeps a public marketing
 * video out of it, and `status: 'active'` means an already-archived or
 * already-tombstoned row is never touched twice.
 */
export const RETENTION_VIDEO_PROVIDERS: readonly MediaAssetProvider[] = [
  'r2_worker',
  'cloudflare_stream',
];

export function retentionAssetFilter(): Prisma.MediaAssetWhereInput {
  return {
    type: 'video',
    access: 'protected',
    status: 'active',
    provider: { in: [...RETENTION_VIDEO_PROVIDERS] },
  };
}

const HOLD_CASE_STATUSES = ['open', 'in_progress'] as const;

@Injectable()
export class VideoRetentionRepository {
  /**
   * The organisations that COULD have a retention step due at `now`.
   *
   * Only the stored terminal statuses appear: a `trialing` row whose clock
   * has elapsed is effectively `trial_expired`, but its anchor is hours
   * old, not ninety days, so it cannot be inside any window. `grace_period`
   * is included for the row the expiry sweep has not transitioned yet,
   * whose derived anchor really can be old.
   *
   * `organization.status: 'active'` is not a nicety. A suspended or
   * archived organisation is in an administrative state somebody put it
   * in, and automated destruction of its content while it sits there
   * would be the wrong answer to every question anyone later asks.
   */
  findCandidates(
    tx: Prisma.TransactionClient,
    now: Date,
    cursor: string | undefined,
    take: number,
  ): Promise<RetentionCandidate[]> {
    const trial = retentionCandidateAnchorRange('trial', now);
    const paid = retentionCandidateAnchorRange('paid', now);
    return tx.tenantSubscription.findMany({
      where: {
        organization: { status: 'active' },
        OR: [
          {
            status: 'trial_expired',
            trialEndsAt: { gte: trial.earliest, lte: trial.latest },
          },
          {
            status: 'expired',
            graceEndsAt: { gte: paid.earliest, lte: paid.latest },
          },
          {
            status: 'grace_period',
            graceEndsAt: { gte: paid.earliest, lte: paid.latest },
          },
          // A cancellation's own `effectiveAt` is the anchor, and it lives
          // on another table — so the bound here is the union of both
          // origins' spans and the evaluator narrows it.
          {
            status: 'cancelled',
            organization: {
              cancellations: {
                some: { effectiveAt: { gte: paid.earliest, lte: trial.latest } },
              },
            },
          },
        ],
        ...(cursor ? { organizationId: { gt: cursor } } : {}),
      },
      select: {
        organizationId: true,
        status: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        graceEndsAt: true,
        cancelAtPeriodEnd: true,
        organization: {
          select: {
            id: true,
            name: true,
            status: true,
            owner: { select: { id: true, email: true, status: true, deletedAt: true } },
            cancellations: { select: { kind: true, effectiveAt: true } },
            lifecycleState: {
              select: { legalHold: true, holdReason: true, deletionScheduledAt: true },
            },
          },
        },
      },
      orderBy: { organizationId: 'asc' },
      take,
    });
  }

  /** One organisation's candidate row, re-read at job-execution time. */
  findCandidate(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<RetentionCandidate | null> {
    return tx.tenantSubscription.findFirst({
      where: { organizationId },
      select: {
        organizationId: true,
        status: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        graceEndsAt: true,
        cancelAtPeriodEnd: true,
        organization: {
          select: {
            id: true,
            name: true,
            status: true,
            owner: { select: { id: true, email: true, status: true, deletedAt: true } },
            cancellations: { select: { kind: true, effectiveAt: true } },
            lifecycleState: {
              select: { legalHold: true, holdReason: true, deletionScheduledAt: true },
            },
          },
        },
      },
    });
  }

  /**
   * §31's hold — the per-organisation legal-hold flag, or an open support
   * case.
   *
   * §31 says "an open support case TAGGED 'data'". `support_cases` has no
   * tag column and this workstream is forbidden from adding one, so the
   * rule implemented is the strictly broader one: ANY open or in-progress
   * case freezes the sequence. Broader is the safe direction — it can only
   * ever prevent a deletion, never cause one — and the narrowing to a real
   * tag is a schema change recorded for the owner rather than faked with a
   * substring match on a subject line somebody typed.
   */
  async resolveHold(
    tx: Prisma.TransactionClient,
    organizationId: string,
    lifecycleState: { legalHold: boolean; holdReason: string | null } | null,
  ): Promise<RetentionHold> {
    if (lifecycleState?.legalHold) {
      return { held: true, reason: lifecycleState.holdReason ?? 'legal_hold' };
    }
    const openCase = await tx.supportCase.findFirst({
      where: { organizationId, status: { in: [...HOLD_CASE_STATUSES] } },
      select: { id: true },
    });
    if (openCase) return { held: true, reason: `support_case:${openCase.id}` };
    return { held: false, reason: null };
  }

  /**
   * Guard (2) — which of W1-W4 this organisation's owner actually has an
   * outbox row for, at THIS anchor.
   *
   * The dedupe key is the evidence, not a flag: it embeds the anchor, so
   * warnings from a previous lapse cannot be mistaken for warnings about
   * this deletion date. Row STATE is deliberately ignored — a warning that
   * hard-bounced was still sent, and §31 says W4 goes out "even if W1-W3
   * bounced". What is being asserted is that the sequence ran, not that
   * the customer read it.
   */
  async findWarningsSent(
    tx: Prisma.TransactionClient,
    recipientUserId: string,
    organizationId: string,
    anchorAt: Date,
  ): Promise<Set<RetentionStepId>> {
    const keys = RETENTION_WARNING_STEPS.map(
      (step) => `lifecycle_${step}:${organizationId}:${anchorAt.toISOString()}`,
    );
    const rows = await tx.communicationOutbox.findMany({
      where: { recipientUserId, dedupeKey: { in: keys } },
      select: { dedupeKey: true },
    });
    const found = new Set(rows.map((row) => row.dedupeKey));
    return new Set(
      RETENTION_WARNING_STEPS.filter((_step, index) => found.has(keys[index])),
    );
  }

  /** What the warnings have to tell the owner: how much video, how long, which courses. */
  async tally(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<RetentionTally> {
    const assets = await tx.mediaAsset.findMany({
      where: { ...retentionAssetFilter(), academy: { organizationId } },
      select: { sizeBytes: true, durationSeconds: true, courseId: true },
    });
    let totalBytes = 0n;
    let totalSeconds = 0;
    const courseIds = new Set<string>();
    for (const asset of assets) {
      totalBytes += asset.sizeBytes;
      totalSeconds += asset.durationSeconds ?? 0;
      if (asset.courseId) courseIds.add(asset.courseId);
    }
    const courses = courseIds.size
      ? await tx.course.findMany({
          where: { id: { in: [...courseIds] } },
          select: { title: true },
          orderBy: { title: 'asc' },
        })
      : [];
    return {
      assetCount: assets.length,
      totalBytes,
      totalMinutes: Math.round(totalSeconds / 60),
      courseTitles: courses.map((course) => course.title),
    };
  }

  /** The assets one deletion run will act on, oldest first, bounded. */
  findDeletableAssets(
    tx: Prisma.TransactionClient,
    organizationId: string,
    take: number,
  ): Promise<RetentionAsset[]> {
    return tx.mediaAsset.findMany({
      where: { ...retentionAssetFilter(), academy: { organizationId } },
      select: ASSET_SELECT,
      orderBy: { createdAt: 'asc' },
      take,
    });
  }

  /**
   * One asset, re-read at job-execution time.
   *
   * Not filtered by `retentionAssetFilter()`: the job needs to be able to
   * tell "already a tombstone" (a retry after a successful run) apart from
   * "no longer eligible", and a filtered read collapses both into null.
   */
  findAsset(
    tx: Prisma.TransactionClient,
    assetId: string,
    organizationId: string,
  ): Promise<RetentionAsset | null> {
    return tx.mediaAsset.findFirst({
      where: { id: assetId, academy: { organizationId } },
      select: ASSET_SELECT,
    });
  }

  /**
   * The tombstone. Called ONLY after the provider confirmed the bytes are
   * gone AND an independent probe found them absent.
   *
   * `deletionFailedAt` is cleared here because a successful retry after a
   * failed attempt must not leave the row claiming both.
   *
   * Guarded by `status: 'active'` in the WHERE, so two racing jobs cannot
   * both write a tombstone and double-count `bytesFreed` in the audit.
   * Returns how many rows it actually changed, because under RLS a write
   * with no matching policy affects zero rows WITHOUT raising — the caller
   * treats zero as a failure rather than as done.
   */
  async writeTombstone(
    tx: Prisma.TransactionClient,
    input: {
      readonly assetId: string;
      readonly organizationId: string;
      readonly deletedAt: Date;
      readonly reason: string;
      readonly bytesFreed: bigint;
    },
  ): Promise<number> {
    const result = await tx.mediaAsset.updateMany({
      where: {
        id: input.assetId,
        status: 'active',
        academy: { organizationId: input.organizationId },
      },
      data: {
        status: 'deleted',
        deletedAt: input.deletedAt,
        deletionReason: input.reason,
        bytesFreed: input.bytesFreed,
        deletionFailedAt: null,
      },
    });
    return result.count;
  }

  /**
   * A failed attempt. `status` is deliberately NOT touched: the bytes may
   * still be there, and a row that says `deleted` when the video still
   * plays is the one outcome this workstream exists to prevent.
   */
  async markDeletionFailed(
    tx: Prisma.TransactionClient,
    assetId: string,
    organizationId: string,
    at: Date,
  ): Promise<number> {
    const result = await tx.mediaAsset.updateMany({
      where: { id: assetId, status: 'active', academy: { organizationId } },
      data: { deletionFailedAt: at },
    });
    return result.count;
  }

  /** How one run's assets ended up — the tenant job's input for D. */
  async settlement(
    tx: Prisma.TransactionClient,
    organizationId: string,
    assetIds: readonly string[],
  ): Promise<{
    readonly deleted: RetentionAsset[];
    readonly failed: RetentionAsset[];
    readonly pending: RetentionAsset[];
  }> {
    const rows = await tx.mediaAsset.findMany({
      where: { id: { in: [...assetIds] }, academy: { organizationId } },
      select: ASSET_SELECT,
    });
    return {
      deleted: rows.filter((row) => row.status === 'deleted'),
      failed: rows.filter(
        (row) => row.status !== 'deleted' && row.deletionFailedAt !== null,
      ),
      pending: rows.filter(
        (row) => row.status !== 'deleted' && row.deletionFailedAt === null,
      ),
    };
  }

  /**
   * Records WHEN this organisation's video is scheduled to go, for the
   * owner dashboard and the Platform Owner's retention view.
   *
   * `phase`, `origin` and `anchor_at` are NOT written here. C5's
   * `TenantLifecycleStateRepository.upsertState` rewrites those on every
   * tick from its own evaluator, and two services writing the same column
   * every fifteen minutes would flap. This one owns exactly the column C5
   * documents as belonging to C6 and leaves the rest alone — the mirror
   * image of C5 never touching `legal_hold`.
   */
  async setDeletionScheduledAt(
    tx: Prisma.TransactionClient,
    organizationId: string,
    at: Date | null,
  ): Promise<void> {
    await tx.tenantLifecycleState.upsert({
      where: { organizationId },
      create: { organizationId, deletionScheduledAt: at },
      update: { deletionScheduledAt: at },
    });
  }
}

const ASSET_SELECT = {
  id: true,
  academyId: true,
  status: true,
  provider: true,
  providerId: true,
  storageKey: true,
  fileName: true,
  sizeBytes: true,
  durationSeconds: true,
  courseId: true,
  deletedAt: true,
  deletionFailedAt: true,
} as const;
