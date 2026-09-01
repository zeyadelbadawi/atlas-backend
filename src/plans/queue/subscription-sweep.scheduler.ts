/**
 * SubscriptionSweepScheduler — Phase 2's real scheduled-task
 * infrastructure (roadmap: "currently none exists anywhere ... zero
 * `@Cron`/`ScheduleModule` usage in the whole codebase"). Registers ONE
 * BullMQ repeatable job on application bootstrap — reusing BullMQ's own
 * native `repeat` option rather than adding a second, parallel scheduling
 * dependency (`@nestjs/schedule`) alongside the queue engine this
 * codebase already runs everywhere else (`TenantUsageRecomputeProducer`,
 * `MediaProcessingProducer`, `PasswordResetEmailProducer`). This is the
 * literal reading of "use one mechanism for both trial expiry and usage
 * recomputation, not two separate ones": one queue, one repeatable job,
 * one processor (`SubscriptionSweepProcessor` → `SubscriptionSweepService`,
 * which itself calls both `SubscriptionExpiryService` and the usage-
 * recompute safety net) — never two independent schedulers.
 *
 * `queue.add` with a fixed `jobId` + identical `repeat` options is
 * idempotent — BullMQ deduplicates by the repeat key, so calling this on
 * every app boot (including every instance in a multi-instance
 * deployment) never accumulates duplicate recurring jobs.
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  SUBSCRIPTION_SWEEP_INTERVAL_MS,
  SUBSCRIPTION_SWEEP_JOB,
  SUBSCRIPTION_SWEEP_QUEUE,
  SUBSCRIPTION_SWEEP_REPEAT_JOB_ID,
  SubscriptionSweepJobPayload,
} from './subscription-sweep.types';

@Injectable()
export class SubscriptionSweepScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(SubscriptionSweepScheduler.name);

  constructor(
    @InjectQueue(SUBSCRIPTION_SWEEP_QUEUE)
    private readonly queue: Queue<SubscriptionSweepJobPayload>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.add(
      SUBSCRIPTION_SWEEP_JOB,
      {},
      {
        repeat: { every: SUBSCRIPTION_SWEEP_INTERVAL_MS },
        jobId: SUBSCRIPTION_SWEEP_REPEAT_JOB_ID,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    this.logger.log(
      { intervalMs: SUBSCRIPTION_SWEEP_INTERVAL_MS },
      'Registered recurring subscription-sweep job.',
    );
  }
}
