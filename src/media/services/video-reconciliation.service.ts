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
import { PrismaService } from '../../database/prisma.service';
import { TenantUsageRecomputeProducer } from '../../plans/queue/tenant-usage-recompute.producer';
import { HOSTED_VIDEO_PROVIDERS } from '../video/hosted-video-providers';
import { VideoProviderRegistry } from '../video/video-provider.registry';
import type { VideoWebhookEvent } from '../video/video-provider.interface';

@Injectable()
export class VideoReconciliationService {
  private readonly logger = new Logger(VideoReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantUsageRecomputeProducer: TenantUsageRecomputeProducer,
    private readonly videoProviders: VideoProviderRegistry,
  ) {}

  /**
   * Applies one already-VERIFIED provider event.
   *
   * Runs without a tenant context on purpose: the caller is the provider,
   * which is not an Atlas user and has no organization. The row is
   * addressed by an identifier only the provider and Atlas know
   * (`provider_id`), the signature has already been checked, and nothing
   * about the event names a tenant — so there is no tenant claim here to
   * trust or to verify. The academy is READ from the row, never taken
   * from the payload.
   */
  async applyEvent(event: VideoWebhookEvent): Promise<void> {
    const asset = await this.prisma.mediaAsset.findFirst({
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
    });
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

    await this.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        processingStatus: event.status,
        ...(hasRealDuration ? { durationSeconds: event.durationSeconds! } : {}),
        // A failed asset stops consuming quota. Archiving rather than
        // deleting keeps the row (and the reason) visible to staff.
        ...(event.status === 'failed' ? { status: 'archived' as const } : {}),
      },
    });

    // P64 Phase 2 — a lesson shows the authoritative duration the provider
    // measured, so the watched-ratio denominator matches the real video.
    // Only filled in when the author has not set one explicitly.
    if (hasRealDuration) {
      await this.prisma.courseLesson.updateMany({
        where: { videoAssetId: asset.id, durationSeconds: null },
        data: { durationSeconds: event.durationSeconds! },
      });
    }

    await this.tenantUsageRecomputeProducer.enqueueOne(asset.academy.organizationId);
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
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
    const stalled = await this.prisma.mediaAsset.findMany({
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
    });

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
}
