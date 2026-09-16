import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  DOMAIN_VERIFICATION_SWEEP_INTERVAL_MS,
  DOMAIN_VERIFICATION_SWEEP_JOB,
  DOMAIN_VERIFICATION_SWEEP_QUEUE,
  DOMAIN_VERIFICATION_SWEEP_REPEAT_JOB_ID,
  DomainVerificationSweepJobPayload,
} from './domain-verification-sweep.types';

/** Registers the one repeatable job on boot — idempotent by `jobId`, exactly like `SubscriptionSweepScheduler`. */
@Injectable()
export class DomainVerificationSweepScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(DomainVerificationSweepScheduler.name);

  constructor(
    @InjectQueue(DOMAIN_VERIFICATION_SWEEP_QUEUE)
    private readonly queue: Queue<DomainVerificationSweepJobPayload>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.add(
      DOMAIN_VERIFICATION_SWEEP_JOB,
      {},
      {
        repeat: { every: DOMAIN_VERIFICATION_SWEEP_INTERVAL_MS },
        jobId: DOMAIN_VERIFICATION_SWEEP_REPEAT_JOB_ID,
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
      },
    );
    this.logger.log(
      { intervalMs: DOMAIN_VERIFICATION_SWEEP_INTERVAL_MS },
      'Registered recurring domain-verification-sweep job.',
    );
  }
}
