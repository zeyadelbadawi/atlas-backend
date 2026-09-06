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
        // Phase 4.5.2 (scalability, Change 5) — `removeOnFail: false` is
        // this codebase's deliberate, consistent convention everywhere
        // else (password-reset, provisioning, billing-webhook, media-
        // processing), kept there unchanged: those queues are low-volume,
        // so unbounded failed-job retention is genuinely harmless and
        // gives an operator permanent visibility into every failure. This
        // is the highest-volume queue on the platform (one job per stale
        // organization, potentially thousands per tick) — unbounded
        // retention here would let Redis memory grow without limit under
        // any sustained partial-failure rate. Bounded to the most recent
        // 1,000 failed jobs: enough for real operator debugging, never
        // unbounded.
        removeOnFail: { count: 1000 },
      },
    );
  }
}
