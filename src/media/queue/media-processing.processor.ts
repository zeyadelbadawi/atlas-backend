/**
 * MediaProcessingProcessor — the `Worker` half (master plan §12
 * "Media processing (thumbnail/dimensions)"). Thin: delegates the actual
 * bytes-to-dimensions work to `sharp`, everything else to
 * `MediaAssetsRepository`/`MediaStorageProvider`, mirroring
 * `TenantUsageRecomputeProcessor`'s "thin processor, real logic in a
 * service/util" shape.
 *
 * Idempotent and retry-safe by construction: every run overwrites only
 * `width`/`height` (never any other column, never re-uploads, never
 * deletes) — running it twice for the same asset produces the same
 * result both times. Only `image` assets get real dimensions; `document`/
 * `other` are skipped, not retried, not treated as a failure (there is
 * nothing to extract). A genuine failure (corrupt bytes, storage
 * temporarily unreachable) is re-thrown so BullMQ's configured
 * backoff/retry applies (master plan §12) — the original `media_assets`
 * row and its real `url`/`storage_key` are never touched by this class at
 * all, so a failure here can never destroy the asset itself (master plan
 * §12: "original stays queryable even if thumbnailing fails").
 *
 * No thumbnail file is generated — see this module's own thumbnail-design
 * note in `media.module.ts`'s doc comment for why: the real frontend
 * contract (`MediaAssetSummary`) has no thumbnail-url field at all, only
 * `dimensions`, so a generated thumbnail object would have no response
 * shape to ever be returned through (master plan's "do not invent a new
 * public response shape" instruction).
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import sharp from 'sharp';
import type { Job } from 'bullmq';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { MediaAssetsRepository } from '../repositories/media-assets.repository';
import { MEDIA_STORAGE_PROVIDER } from '../storage/media-storage.interface';
import type { MediaStorageProvider } from '../storage/media-storage.interface';
import {
  MEDIA_PROCESSING_QUEUE,
  ProcessMediaAssetJobPayload,
} from './media-processing.types';

@Processor(MEDIA_PROCESSING_QUEUE)
export class MediaProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(MediaProcessingProcessor.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly mediaAssetsRepository: MediaAssetsRepository,
    @Inject(MEDIA_STORAGE_PROVIDER)
    private readonly storageProvider: MediaStorageProvider,
  ) {
    super();
  }

  async process(job: Job<ProcessMediaAssetJobPayload>): Promise<void> {
    const { mediaAssetId, academyId, organizationId } = job.data;
    this.logger.log({ jobId: job.id, mediaAssetId }, 'Processing media-processing job');

    const asset = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.mediaAssetsRepository.findById(tx, academyId, mediaAssetId),
    );
    if (!asset) {
      // Archived-then-reprocessed races, or a genuinely stale job after a
      // retry storm — nothing to do, not a failure.
      this.logger.warn({ mediaAssetId }, 'Media asset no longer found; skipping.');
      return;
    }
    if (asset.type !== 'image') {
      return;
    }

    const bytes = await this.storageProvider.getObject(asset.storageKey);
    const { width, height } = await sharp(bytes).metadata();
    if (!width || !height) {
      this.logger.warn(
        { mediaAssetId },
        'Could not determine image dimensions; leaving unset.',
      );
      return;
    }

    await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
      this.mediaAssetsRepository.update(tx, mediaAssetId, { width, height }),
    );
  }
}
