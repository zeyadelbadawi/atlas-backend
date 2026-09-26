/**
 * Archived-media purge — owner decision, 26 September 2026.
 *
 * THE POLICY. Archiving (a media asset, or a whole academy — which is what
 * account deletion does to an owner's academies) never destroys bytes on
 * the spot. For MEDIA_PURGE_GRACE_DAYS (30) the resource stays exactly as
 * the existing lifecycle leaves it. Only after that, and only if it is still
 * eligible when the job actually runs, are its bytes destroyed — public R2
 * objects, protected R2 objects, and hosted video (Stream / the Normal tier)
 * alike — and the row becomes a `deleted` tombstone with an audit entry.
 *
 * ELIGIBLE means, re-checked at execution time:
 *   - the asset's academy is archived and was archived ≥ 30 days ago; or
 *   - the asset itself is archived, has not changed for ≥ 30 days, and
 *     nothing in its (active) academy still points at it — a lesson video,
 *     lesson content or a lesson resource;
 *   - and the organization is NOT under legal hold or an open support
 *     case (the retention pipeline's own §31 hold — the stronger rule wins).
 * An asset of an active academy that is itself active is never touched.
 * Certificate PDFs are not media assets and are never touched here.
 *
 * HOUSE DELETION PROPERTIES (docs/ACCOUNT_DELETION_AND_DATA_LIFECYCLE.md §5),
 * reused rather than re-implemented: the same queue and single processor as
 * video retention; deterministic colon-free job ids; hosted video goes
 * through `VideoRetentionDeletionService.destroyAndVerify` (provider-404 is
 * success, absence proven); delete → verify absent → tombstone, strictly in
 * that order; a zero-row tombstone is an error; terminal failures are kept.
 *
 * MODE. `FLAG_MEDIA_ARCHIVE_PURGE_MODE`: `off` does nothing, `dry_run` (the
 * default) finds and logs what WOULD be destroyed and destroys nothing, `on`
 * destroys. The mode is re-read at execution, so switching to `dry_run`
 * stops purges already queued.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { ProtectedMediaStorage } from '../../media/storage/protected-media-storage.provider';
import {
  MEDIA_STORAGE_PROVIDER,
  type MediaStorageProvider,
} from '../../media/storage/media-storage.interface';
import { HOSTED_VIDEO_PROVIDERS } from '../../media/video/hosted-video-providers';
import { PLANS_CLOCK, type Clock } from '../../plans/utils/clock';
import type {
  CommunicationsConfig,
  MediaArchivePurgeMode,
} from '../../config/configuration';
import { VideoRetentionRepository } from '../repositories/video-retention.repository';
import { VideoRetentionDeletionService } from './video-retention-deletion.service';
import {
  MEDIA_PURGE_GRACE_DAYS,
  MEDIA_PURGE_JOB_ASSET,
  MEDIA_PURGE_MAX_ASSETS_PER_TICK,
  VIDEO_RETENTION_QUEUE,
  mediaPurgeAssetJobId,
  type MediaPurgeAssetJobPayload,
  type VideoRetentionJobPayload,
} from '../queue/video-retention.types';

export type MediaPurgeOutcome =
  'purged' | 'already_deleted' | 'not_found' | 'mode_not_on' | 'not_eligible' | 'held';

export const MEDIA_PURGE_REASON = 'archive_grace_elapsed';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ArchivedMediaPurgeService {
  private readonly logger = new Logger(ArchivedMediaPurgeService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly repository: VideoRetentionRepository,
    private readonly deletion: VideoRetentionDeletionService,
    private readonly auditLogWriter: AuditLogWriterService,
    private readonly protectedStorage: ProtectedMediaStorage,
    @Inject(MEDIA_STORAGE_PROVIDER) private readonly publicStorage: MediaStorageProvider,
    private readonly configService: ConfigService,
    @InjectQueue(VIDEO_RETENTION_QUEUE)
    private readonly queue: Queue<VideoRetentionJobPayload>,
    @Inject(PLANS_CLOCK) private readonly clock: Clock,
  ) {}

  get mode(): MediaArchivePurgeMode {
    return this.configService.getOrThrow<CommunicationsConfig>('communications')
      .mediaArchivePurgeMode;
  }

  /**
   * One tick: find what has passed the grace period and, in `on`, enqueue
   * one purge job per asset. Returns the eligible asset ids (for `dry_run`
   * reporting and tests). Never destroys anything itself.
   */
  async sweep(): Promise<readonly MediaPurgeAssetJobPayload[]> {
    const mode = this.mode;
    if (mode === 'off') return [];
    const actorUserId = await this.resolveActor();
    if (!actorUserId) return [];

    const candidates = await this.findCandidates(actorUserId, this.clock.now());
    if (mode === 'dry_run') {
      if (candidates.length > 0) {
        this.logger.log(
          { mode, count: candidates.length, assetIds: candidates.map((c) => c.assetId) },
          'Archived-media purge (dry run): these assets are past the 30-day grace and would be destroyed.',
        );
      }
      return candidates;
    }
    for (const candidate of candidates) {
      await this.queue.add(MEDIA_PURGE_JOB_ASSET, candidate, {
        jobId: mediaPurgeAssetJobId(candidate.assetId),
        attempts: 5,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: true,
        removeOnFail: false,
      });
    }
    return candidates;
  }

  /**
   * Candidates across every tenant, read in the platform-owner context the
   * retention sweep already uses for `media_assets`. Deliberately a
   * superset filter; `purgeAsset` makes the binding decision per asset.
   */
  async findCandidates(
    actorUserId: string,
    now: Date,
  ): Promise<readonly MediaPurgeAssetJobPayload[]> {
    const cutoff = new Date(now.getTime() - MEDIA_PURGE_GRACE_DAYS * DAY_MS);
    const rows = await this.tenancyContextService.runInUserContext(actorUserId, (tx) =>
      tx.mediaAsset.findMany({
        where: {
          status: { in: ['active', 'archived'] },
          OR: [
            { status: 'archived', updatedAt: { lte: cutoff } },
            { academy: { status: 'archived', archivedAt: { lte: cutoff } } },
          ],
        },
        orderBy: { updatedAt: 'asc' },
        take: MEDIA_PURGE_MAX_ASSETS_PER_TICK,
        select: { id: true, academy: { select: { organizationId: true } } },
      }),
    );
    return rows.map((row) => ({
      assetId: row.id,
      organizationId: row.academy.organizationId,
    }));
  }

  /** One asset: re-validate everything, destroy, prove absence, tombstone + audit. */
  async purgeAsset(payload: MediaPurgeAssetJobPayload): Promise<MediaPurgeOutcome> {
    if (this.mode !== 'on') return 'mode_not_on';
    const actorUserId = await this.resolveActor();
    if (!actorUserId) return 'mode_not_on';
    const now = this.clock.now();

    const state = await this.tenancyContextService.runInTenantContext(
      payload.organizationId,
      async (tx) => {
        const asset = await tx.mediaAsset.findFirst({
          where: {
            id: payload.assetId,
            academy: { organizationId: payload.organizationId },
          },
          select: {
            id: true,
            academyId: true,
            status: true,
            updatedAt: true,
            provider: true,
            providerId: true,
            storageKey: true,
            access: true,
            fileName: true,
            sizeBytes: true,
            academy: { select: { status: true, archivedAt: true } },
          },
        });
        if (!asset) return null;
        const referenced = await isReferenced(tx, asset.id);
        const lifecycle = await tx.tenantLifecycleState.findUnique({
          where: { organizationId: payload.organizationId },
          select: { legalHold: true, holdReason: true },
        });
        const hold = await this.repository.resolveHold(
          tx,
          payload.organizationId,
          lifecycle,
        );
        return { asset, referenced, held: hold.held };
      },
    );

    if (!state) return 'not_found';
    const { asset } = state;
    if (asset.status === 'deleted') return 'already_deleted';
    if (!isPurgeEligible({ ...asset, referenced: state.referenced }, now))
      return 'not_eligible';
    if (state.held) return 'held';

    await this.destroyAndVerify(asset);

    const changed = await this.tenancyContextService.runInTenantAndUserContext(
      payload.organizationId,
      actorUserId,
      async (tx) => {
        const count = await this.repository.writeTombstone(tx, {
          assetId: asset.id,
          organizationId: payload.organizationId,
          deletedAt: now,
          reason: MEDIA_PURGE_REASON,
          bytesFreed: asset.sizeBytes,
          fromStatuses: ['active', 'archived'],
        });
        if (count === 0) return 0;
        await this.auditLogWriter.write(tx, {
          actorUserId,
          organizationId: payload.organizationId,
          academyId: asset.academyId,
          role: 'platform_owner',
          action: 'media.asset.purged',
          targetType: 'media_asset',
          targetId: asset.id,
          targetLabel: asset.fileName,
          context: {
            assetId: asset.id,
            provider: asset.provider,
            bytes: Number(asset.sizeBytes),
            reason: MEDIA_PURGE_REASON,
            graceDays: MEDIA_PURGE_GRACE_DAYS,
          },
        });
        return count;
      },
    );
    if (changed === 0) {
      // Zero rows: either a concurrent run of this same purge tombstoned it
      // first (fine — the outcome is identical), or RLS silently refused the
      // write while the bytes are gone (the one state worth failing on).
      const current = await this.tenancyContextService.runInTenantContext(
        payload.organizationId,
        (tx) =>
          tx.mediaAsset.findFirst({ where: { id: asset.id }, select: { status: true } }),
      );
      if (current?.status === 'deleted') return 'already_deleted';
      throw new Error(
        `Archived-media purge: bytes of ${asset.id} are verifiably gone but the tombstone changed no row.`,
      );
    }
    return 'purged';
  }

  private async destroyAndVerify(asset: {
    readonly id: string;
    readonly provider: string;
    readonly providerId: string | null;
    readonly storageKey: string;
    readonly access: string;
  }): Promise<void> {
    if ((HOSTED_VIDEO_PROVIDERS as readonly string[]).includes(asset.provider)) {
      await this.deletion.destroyAndVerify(
        asset as Parameters<VideoRetentionDeletionService['destroyAndVerify']>[0],
      );
      return;
    }
    if (!asset.storageKey) return;
    if (asset.access === 'protected') {
      await this.protectedStorage.deleteObject(asset.storageKey);
      if ((await this.protectedStorage.headObject(asset.storageKey)) !== null) {
        throw new Error(
          `Archived-media purge: protected object still present: ${asset.id}`,
        );
      }
      return;
    }
    await this.publicStorage.deleteObject(asset.storageKey);
    if (await this.publicStorage.objectExists(asset.storageKey)) {
      throw new Error(`Archived-media purge: public object still present: ${asset.id}`);
    }
  }

  private async resolveActor(): Promise<string | null> {
    const owner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!owner) {
      this.logger.error(
        'No platform owner exists; the archived-media purge was skipped.',
      );
      return null;
    }
    return owner.id;
  }
}

/** Whether any lesson still points at the asset (video, content or resource). */
async function isReferenced(
  tx: Prisma.TransactionClient,
  assetId: string,
): Promise<boolean> {
  const [lesson, content, resource] = await Promise.all([
    tx.courseLesson.findFirst({ where: { videoAssetId: assetId }, select: { id: true } }),
    tx.lessonContent.findFirst({
      where: { mediaAssetId: assetId },
      select: { id: true },
    }),
    tx.lessonResource.findFirst({
      where: { mediaAssetId: assetId },
      select: { id: true },
    }),
  ]);
  return lesson !== null || content !== null || resource !== null;
}

/**
 * The binding eligibility rule — pure, so it is the same function whether
 * it is asked by a test or by a job running weeks after the sweep.
 */
export function isPurgeEligible(
  asset: {
    readonly status: string;
    readonly updatedAt: Date;
    readonly referenced: boolean;
    readonly academy: { readonly status: string; readonly archivedAt: Date | null };
  },
  now: Date,
): boolean {
  if (asset.status === 'deleted') return false;
  const cutoff = now.getTime() - MEDIA_PURGE_GRACE_DAYS * DAY_MS;
  if (asset.academy.status === 'archived') {
    return (
      asset.academy.archivedAt !== null && asset.academy.archivedAt.getTime() <= cutoff
    );
  }
  return (
    asset.status === 'archived' &&
    asset.updatedAt.getTime() <= cutoff &&
    !asset.referenced
  );
}
