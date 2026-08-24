/** TenantUsageRecomputeProducer — the `Service → Domain Event → BullMQ Queue` half, mirroring `PasswordResetEmailProducer`'s pattern exactly. */
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  RECOMPUTE_ONE_JOB,
  RecomputeOneJobPayload,
  TENANT_USAGE_RECOMPUTE_QUEUE,
} from './tenant-usage-recompute.types';

@Injectable()
export class TenantUsageRecomputeProducer {
  constructor(
    @InjectQueue(TENANT_USAGE_RECOMPUTE_QUEUE)
    private readonly queue: Queue<RecomputeOneJobPayload>,
  ) {}

  async enqueueOne(organizationId: string): Promise<void> {
    await this.queue.add(
      RECOMPUTE_ONE_JOB,
      { organizationId },
      {
        // Idempotent full recompute (master plan §12) — safe to retry on
        // transient failure without any special dedup key.
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }
}
