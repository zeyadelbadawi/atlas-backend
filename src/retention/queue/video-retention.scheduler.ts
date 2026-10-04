/**
 * Registers the one repeatable `sweep` job on the `video-retention` queue
 * (P64 Communications C6), following `SubscriptionSweepScheduler` exactly:
 * a fixed `jobId` plus identical `repeat` options is idempotent, so every
 * boot of every instance re-registers the same recurring job rather than
 * accumulating duplicates.
 *
 * Registration happens regardless of `FLAG_VIDEO_RETENTION_MODE`. The tick
 * itself returns immediately while the mode is `off`, which is the same
 * shape the subscription sweep has for the lifecycle sequences: the
 * schedule is infrastructure, the flag is the decision, and keeping them
 * separate means turning the feature on does not also require a deploy.
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  VIDEO_RETENTION_JOB_SWEEP,
  VIDEO_RETENTION_QUEUE,
  VIDEO_RETENTION_SWEEP_INTERVAL_MS,
  MEDIA_PURGE_JOB_SWEEP,
  MEDIA_PURGE_SWEEP_INTERVAL_MS,
  MEDIA_PURGE_SWEEP_REPEAT_JOB_ID,
  TRIAL_FORENSICS_SCRUB_INTERVAL_MS,
  TRIAL_FORENSICS_SCRUB_JOB,
  TRIAL_FORENSICS_SCRUB_REPEAT_JOB_ID,
  VIDEO_RETENTION_SWEEP_REPEAT_JOB_ID,
  type VideoRetentionJobPayload,
} from './video-retention.types';

@Injectable()
export class VideoRetentionScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(VideoRetentionScheduler.name);

  constructor(
    @InjectQueue(VIDEO_RETENTION_QUEUE)
    private readonly queue: Queue<VideoRetentionJobPayload>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.add(
      VIDEO_RETENTION_JOB_SWEEP,
      { kind: 'sweep' },
      {
        repeat: { every: VIDEO_RETENTION_SWEEP_INTERVAL_MS },
        jobId: VIDEO_RETENTION_SWEEP_REPEAT_JOB_ID,
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
      },
    );
    this.logger.log(
      { intervalMs: VIDEO_RETENTION_SWEEP_INTERVAL_MS },
      'Registered recurring video-retention sweep job.',
    );
    // Archived-media purge — same queue, same processor (see
    // `ArchivedMediaPurgeService`). What it does is decided by its mode.
    await this.queue.add(
      MEDIA_PURGE_JOB_SWEEP,
      { kind: 'sweep' },
      {
        repeat: { every: MEDIA_PURGE_SWEEP_INTERVAL_MS },
        jobId: MEDIA_PURGE_SWEEP_REPEAT_JOB_ID,
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
      },
    );
    // W8B — trial-ledger IP/user-agent retention (180 days).
    await this.queue.add(
      TRIAL_FORENSICS_SCRUB_JOB,
      { kind: 'sweep' },
      {
        repeat: { every: TRIAL_FORENSICS_SCRUB_INTERVAL_MS },
        jobId: TRIAL_FORENSICS_SCRUB_REPEAT_JOB_ID,
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
      },
    );
  }
}
