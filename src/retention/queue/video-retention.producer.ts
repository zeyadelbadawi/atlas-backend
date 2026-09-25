/**
 * VideoRetentionProducer — the only thing that puts work on the
 * `video-retention` queue (P64 Communications C6).
 *
 * Every id is DETERMINISTIC: one asset plus one anchor is one job,
 * forever. A sweep tick fifteen minutes after the one that enqueued a
 * deletion re-derives the identical id and BullMQ silently refuses the
 * duplicate, which is the queue-level counterpart of the database's
 * dedupe key — and the reason a repeated tick cannot fan one asset out
 * into ninety-six competing delete jobs.
 *
 * Ids contain no `:` (P64 Phase 3: BullMQ treats a colon in a custom job
 * id as a key separator).
 */
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  retentionAssetJobId,
  retentionTenantJobId,
  VIDEO_RETENTION_ASSET_ATTEMPTS,
  VIDEO_RETENTION_ASSET_BACKOFF_MS,
  VIDEO_RETENTION_JOB_ASSET,
  VIDEO_RETENTION_JOB_TENANT,
  VIDEO_RETENTION_QUEUE,
  VIDEO_RETENTION_TENANT_ATTEMPTS,
  VIDEO_RETENTION_TENANT_BACKOFF_MS,
  VIDEO_RETENTION_TENANT_DELAY_MS,
  type VideoRetentionAssetJobPayload,
  type VideoRetentionJobPayload,
  type VideoRetentionTenantJobPayload,
} from './video-retention.types';

@Injectable()
export class VideoRetentionProducer {
  constructor(
    @InjectQueue(VIDEO_RETENTION_QUEUE)
    private readonly queue: Queue<VideoRetentionJobPayload>,
  ) {}

  async enqueueAsset(payload: VideoRetentionAssetJobPayload): Promise<void> {
    await this.queue.add(VIDEO_RETENTION_JOB_ASSET, payload, {
      jobId: retentionAssetJobId(payload.assetId, new Date(payload.anchorAt)),
      attempts: VIDEO_RETENTION_ASSET_ATTEMPTS,
      backoff: { type: 'exponential', delay: VIDEO_RETENTION_ASSET_BACKOFF_MS },
      removeOnComplete: true,
      // Kept, not discarded: a deletion that exhausted its attempts is the
      // one job on this queue somebody has to look at.
      removeOnFail: false,
    });
  }

  async enqueueTenantSettlement(payload: VideoRetentionTenantJobPayload): Promise<void> {
    await this.queue.add(VIDEO_RETENTION_JOB_TENANT, payload, {
      jobId: retentionTenantJobId(payload.organizationId, new Date(payload.anchorAt)),
      delay: VIDEO_RETENTION_TENANT_DELAY_MS,
      attempts: VIDEO_RETENTION_TENANT_ATTEMPTS,
      backoff: { type: 'exponential', delay: VIDEO_RETENTION_TENANT_BACKOFF_MS },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
