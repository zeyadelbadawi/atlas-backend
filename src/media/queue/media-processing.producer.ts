/** MediaProcessingProducer — the `Service → Domain Event → BullMQ Queue` half, mirroring `TenantUsageRecomputeProducer`'s pattern exactly. */
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  MEDIA_PROCESSING_QUEUE,
  PROCESS_MEDIA_ASSET_JOB,
  ProcessMediaAssetJobPayload,
} from './media-processing.types';

@Injectable()
export class MediaProcessingProducer {
  constructor(
    @InjectQueue(MEDIA_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessMediaAssetJobPayload>,
  ) {}

  async enqueue(
    mediaAssetId: string,
    academyId: string,
    organizationId: string,
  ): Promise<void> {
    await this.queue.add(
      PROCESS_MEDIA_ASSET_JOB,
      { mediaAssetId, academyId, organizationId },
      {
        // Re-runnable safely — overwrites only the derived width/height
        // fields (master plan §12: "Re-runnable safely (overwrites
        // derived fields only)") — no special dedup key needed.
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }
}
