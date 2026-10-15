/**
 * Reconciles Atlas's view of a provider-hosted video with the provider's
 * (master plan Phase 2 §D.4/§D.5, AD-14).
 *
 * TWO INPUTS, ONE PATH. A webhook is the fast path and a status poll is
 * the fallback for a webhook that never arrived — but both end here, so
 * "what happens when a video becomes ready" has exactly one
 * implementation and the poll cannot drift from the webhook.
 *
 * IDEMPOTENT BY PROVIDER ID. Providers retry deliveries, reorder them,
 * and occasionally send the same event twice. The asset is looked up by
 * `provider_id` (UNIQUE per provider, enforced by a partial index) and
 * the write is a plain field update, so replaying an event changes
 * nothing. A LATE event for an asset that is already `ready` is applied
 * anyway when it carries a real duration, because the later measurement
 * is the better one; a late event with no duration is ignored rather
 * than allowed to blank a figure that is already correct.
 *
 * THIS IS WHERE THE RESERVATION BECOMES REAL. Until now
 * `duration_seconds` held the maximum the uploader DECLARED; the
 * provider's measured duration replaces it, which is exactly D5's
 * reconciliation step and the reason a tenant's usage falls once a short
 * video finishes processing.
 */
import { Injectable, Logger } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { TenantUsageRecomputeProducer } from '../../plans/queue/tenant-usage-recompute.producer';
import { HOSTED_VIDEO_PROVIDERS } from '../video/hosted-video-providers';
import { findMediaUsages } from './media-usage.util';
import { VideoProviderRegistry } from '../video/video-provider.registry';
import type { VideoWebhookEvent } from '../video/video-provider.interface';

/**
 * B0-MED-11 — how long an upload to a provider with NO webhook (the Normal
 * tier) may stay unfinished before it counts as abandoned. A day: far
 * longer than the presigned PUT's ten-minute signature plus any realistic
 * transfer of a 5 GiB file, so a slow upload is never cut off, and short
 * enough that a tab closed mid-upload stops holding the tenant's quota by
 * the next day.
 */
export const ABANDONED_VIDEO_UPLOAD_HOURS = 24;

@Injectable()
export class VideoReconciliationService {
  private readonly logger = new Logger(VideoReconciliationService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly tenantUsageRecomputeProducer: TenantUsageRecomputeProducer,
    private readonly videoProviders: VideoProviderRegistry,
  ) {}

  /**
   * Applies one already-VERIFIED provider event.
   *
   * The caller is the provider, which is not an Atlas user and names no
   * tenant, so there is no tenant claim here to trust. The row is
   * addressed by an identifier only the provider and Atlas know
   * (`provider_id`), and the tenant is READ from the row, never taken from
   * the payload.
   *
   * RLS CONTEXT, EXPLICITLY. `media_assets` is FORCE-RLS and every SELECT
   * policy needs an organization, a user or a platform owner — so a read
   * with no context does not error, it returns zero rows. (It used to run
   * with no context, and every event was dropped as "unknown asset".) So:
   *
   *   1. LOCATE in the platform-owner read context the retention sweep
   *      already uses for the same table (`media_assets_platform_select`),
   *      selecting only the id, status and owning organization.
   *   2. WRITE in that organization's tenant context, so the update is
   *      bounded by `media_assets_tenant_update` and the lesson backfill by
   *      the course policies — exactly one tenant, the one the row names.
   */
  async applyEvent(event: VideoWebhookEvent): Promise<void> {
    const actorUserId = await this.resolveReadActor();
    if (!actorUserId) return;

    const asset = await this.tenancyContextService.runInUserContext(actorUserId, (tx) =>
      tx.mediaAsset.findFirst({
        // Any provider that reports readiness asynchronously. Keyed on the
        // provider id, which is unique per provider by partial index.
        where: {
          provider: { in: [...HOSTED_VIDEO_PROVIDERS] },
          providerId: event.providerId,
        },
        select: {
          id: true,
          durationSeconds: true,
          processingStatus: true,
          academy: { select: { organizationId: true } },
        },
      }),
    );
    if (!asset) {
      // An event for an asset Atlas does not know. Not an error — a
      // deleted asset, or an upload from another environment sharing the
      // provider account — but worth seeing.
      this.logger.warn(
        { providerId: event.providerId },
        'Video provider event for an unknown asset; ignored.',
      );
      return;
    }

    const hasRealDuration =
      typeof event.durationSeconds === 'number' && event.durationSeconds >= 0;

    if (asset.processingStatus === 'ready' && !hasRealDuration) {
      // A late, duration-less event must not blank a figure that is
      // already reconciled.
      return;
    }

    const organizationId = asset.academy.organizationId;
    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const updated = await tx.mediaAsset.updateMany({
        where: { id: asset.id },
        data: {
          processingStatus: event.status,
          ...(hasRealDuration ? { durationSeconds: event.durationSeconds! } : {}),
          // A failed asset stops consuming quota. Archiving rather than
          // deleting keeps the row (and the reason) visible to staff.
          ...(event.status === 'failed' ? { status: 'archived' as const } : {}),
        },
      });
      // Zero rows here means the tenant context did not admit the row it
      // was derived from — a context bug, never a benign no-op.
      if (updated.count !== 1) {
        throw new Error(
          `Video reconciliation updated ${updated.count} rows for asset ${asset.id}; expected 1.`,
        );
      }

      // P64 Phase 2 — a lesson shows the authoritative duration the
      // provider measured, so the watched-ratio denominator matches the
      // real video. Only filled in when the author has not set one.
      if (hasRealDuration) {
        await tx.courseLesson.updateMany({
          where: { videoAssetId: asset.id, durationSeconds: null },
          data: { durationSeconds: event.durationSeconds! },
        });
      }
    });

    await this.tenantUsageRecomputeProducer.enqueueOne(organizationId);
  }

  /**
   * The status-poll fallback (Phase 2 §D.4).
   *
   * Asks the provider directly about assets that have been waiting too
   * long, which is the only way to recover from a webhook that was never
   * delivered — the provider will not send it again unprompted, and
   * without this the asset stays `processing` forever and its reservation
   * keeps consuming quota.
   */
  async pollStalled(olderThanMinutes = 30, limit = 25): Promise<number> {
    const actorUserId = await this.resolveReadActor();
    if (!actorUserId) return 0;

    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
    // Cross-tenant by nature, so it reads in the platform-owner context
    // (see `applyEvent`); each write then happens in its own tenant.
    const stalled = await this.tenancyContextService.runInUserContext(actorUserId, (tx) =>
      tx.mediaAsset.findMany({
        where: {
          provider: { in: [...HOSTED_VIDEO_PROVIDERS] },
          processingStatus: { in: ['pending', 'processing'] },
          updatedAt: { lt: cutoff },
          providerId: { not: null },
        },
        // `provider` as well as `providerId`: the adapter is resolved PER
        // ROW (AD-7's playback axis). Polling an `r2_worker` asset with
        // whatever adapter the process-wide setting happened to pick would
        // ask the wrong provider about an id it has never seen.
        select: { providerId: true, provider: true },
        take: limit,
      }),
    );

    let reconciled = 0;
    for (const row of stalled) {
      try {
        const remote = await this.videoProviders
          .forProvider(row.provider)
          .fetchAsset(row.providerId!);
        if (!remote) continue;
        await this.applyEvent({
          providerId: remote.providerId,
          status: remote.status,
          durationSeconds: remote.durationSeconds,
          thumbnailUrl: remote.thumbnailUrl,
          errorReason: remote.errorReason,
        });
        reconciled += 1;
      } catch (error) {
        this.logger.warn(
          {
            providerId: row.providerId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Status poll for a stalled video failed.',
        );
      }
    }
    return reconciled;
  }

  /**
   * B0-MED-11 — releases Normal-tier uploads that were never finished.
   *
   * The status poll above cannot help here: the Normal tier has no remote
   * to ask (`fetchAsset` is null by design) and no webhook, so an upload
   * whose browser went away — a closed tab, a lost connection, a crash
   * before Cancel or completion — would sit at `pending`/`processing`
   * forever, its reservation counting against the tenant's minutes and
   * declared bytes. After `ABANDONED_VIDEO_UPLOAD_HOURS` such an upload is
   * released exactly as a refused completion is: `failed` + `archived`
   * (it stops counting at once), and any bytes that landed are deleted
   * (best effort; the archived-media purge retries).
   *
   * Never touched: an upload a lesson already points at (staff decide —
   * nothing is silently broken), and a row whose status changed since it
   * was read (the conditional update loses the race to a completion or a
   * cancel, which is the right winner).
   */
  async expireAbandonedUploads(
    olderThanHours = ABANDONED_VIDEO_UPLOAD_HOURS,
    limit = 50,
  ): Promise<number> {
    const actorUserId = await this.resolveReadActor();
    if (!actorUserId) return 0;

    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
    const abandoned = await this.tenancyContextService.runInUserContext(
      actorUserId,
      (tx) =>
        tx.mediaAsset.findMany({
          where: {
            // The only hosted provider without a webhook. Stream uploads
            // are the status poll's job and are never expired here.
            provider: 'r2_worker',
            processingStatus: { in: ['pending', 'processing'] },
            updatedAt: { lt: cutoff },
          },
          select: {
            id: true,
            provider: true,
            providerId: true,
            academyId: true,
            url: true,
            academy: { select: { organizationId: true } },
          },
          orderBy: { updatedAt: 'asc' },
          take: limit,
        }),
    );

    let expired = 0;
    for (const row of abandoned) {
      const organizationId = row.academy.organizationId;
      try {
        const released = await this.tenancyContextService.runInTenantContext(
          organizationId,
          async (tx) => {
            if ((await findMediaUsages(tx, row)).length > 0) return false;
            const updated = await tx.mediaAsset.updateMany({
              where: { id: row.id, processingStatus: { in: ['pending', 'processing'] } },
              data: { processingStatus: 'failed', status: 'archived' },
            });
            return updated.count === 1;
          },
        );
        if (!released) continue;
        expired += 1;
        if (row.providerId) {
          await this.videoProviders
            .forProvider(row.provider)
            .deleteAsset(row.providerId)
            .catch((error: unknown) => {
              this.logger.warn(
                {
                  assetId: row.id,
                  error: error instanceof Error ? error.message : String(error),
                },
                'Could not delete an abandoned video upload; the archived-media purge will retry it.',
              );
            });
        }
        await this.tenantUsageRecomputeProducer.enqueueOne(organizationId);
      } catch (error) {
        this.logger.warn(
          {
            assetId: row.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Expiring an abandoned video upload failed; the next sweep will retry.',
        );
      }
    }
    if (expired > 0) {
      this.logger.log({ expired }, 'Released abandoned Normal-tier video uploads.');
    }
    return expired;
  }

  /**
   * The platform-owner identity cross-tenant reads run as — the same
   * resolution the retention sweep and the subscription sweep use. With no
   * platform owner there is no legitimate cross-tenant reader; that is
   * logged as an error rather than degraded into a silent zero-row read.
   */
  private async resolveReadActor(): Promise<string | null> {
    const owner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!owner) {
      this.logger.error(
        'No platform owner exists; video reconciliation cannot read media assets and was skipped.',
      );
      return null;
    }
    return owner.id;
  }
}
