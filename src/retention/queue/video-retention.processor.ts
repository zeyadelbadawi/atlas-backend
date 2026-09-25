/**
 * The ONE worker on the `video-retention` queue (P64 Communications C6).
 *
 * Read `video-retention.types.ts`'s header before adding anything here: a
 * second processor class decorated for this queue, anywhere in the tree,
 * does not handle "its own" jobs — it competes for all of them and
 * silently drops the names it does not know. `one-worker-per-queue.spec.ts` fails the
 * build if one appears. Add a job NAME and a `case`; never a second class.
 *
 * Thin on purpose (`SubscriptionSweepProcessor`'s shape): every real
 * decision lives in a service that a test can call directly with a pinned
 * clock, because "does this delete a paying customer's video" is not a
 * question anyone should have to answer through a queue.
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { VideoRetentionService } from '../services/video-retention.service';
import { VideoRetentionDeletionService } from '../services/video-retention-deletion.service';
import {
  VIDEO_RETENTION_JOB_ASSET,
  VIDEO_RETENTION_JOB_SWEEP,
  VIDEO_RETENTION_JOB_TENANT,
  VIDEO_RETENTION_QUEUE,
  type VideoRetentionAssetJobPayload,
  type VideoRetentionJobPayload,
  type VideoRetentionTenantJobPayload,
} from './video-retention.types';

@Processor(VIDEO_RETENTION_QUEUE)
export class VideoRetentionProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoRetentionProcessor.name);

  constructor(
    private readonly sweep: VideoRetentionService,
    private readonly deletion: VideoRetentionDeletionService,
  ) {
    super();
  }

  async process(job: Job<VideoRetentionJobPayload>): Promise<void> {
    switch (job.name) {
      case VIDEO_RETENTION_JOB_SWEEP:
        await this.sweep.run();
        return;
      case VIDEO_RETENTION_JOB_ASSET:
        await this.deletion.deleteAsset(
          job.data as VideoRetentionAssetJobPayload,
          job.attemptsMade,
        );
        return;
      case VIDEO_RETENTION_JOB_TENANT:
        await this.deletion.settleTenant(job.data as VideoRetentionTenantJobPayload);
        return;
      default:
        // Unreachable while this stays the only processor on the queue —
        // which is precisely the invariant the spec enforces. Logged
        // loudly rather than ignored, because reaching it means a job was
        // about to be acknowledged without being done.
        this.logger.error(
          { jobId: job.id, name: job.name },
          'Unknown job name on the video-retention queue — nothing was done for it.',
        );
        throw new Error(`Unknown video-retention job name: ${job.name}`);
    }
  }
}
