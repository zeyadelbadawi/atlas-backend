/** SubscriptionSweepProcessor — the `Worker` half. Thin: delegates all real logic to `SubscriptionSweepService`, mirroring `TenantUsageRecomputeProcessor`'s "thin processor, real logic in a service" shape. */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { SubscriptionSweepService } from '../services/subscription-sweep.service';
import {
  SubscriptionSweepJobPayload,
  SUBSCRIPTION_SWEEP_QUEUE,
} from './subscription-sweep.types';

@Processor(SUBSCRIPTION_SWEEP_QUEUE)
export class SubscriptionSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(SubscriptionSweepProcessor.name);

  constructor(private readonly sweepService: SubscriptionSweepService) {
    super();
  }

  async process(job: Job<SubscriptionSweepJobPayload>): Promise<void> {
    this.logger.log({ jobId: job.id }, 'Processing subscription-sweep job');
    await this.sweepService.run();
  }
}
