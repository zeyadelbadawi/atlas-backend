import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { DomainVerificationSweepService } from '../services/domain-verification-sweep.service';
import {
  DomainVerificationSweepJobPayload,
  DOMAIN_VERIFICATION_SWEEP_LOCK_MS,
  DOMAIN_VERIFICATION_SWEEP_QUEUE,
} from './domain-verification-sweep.types';

/** P63g — one tick at a time; the lock is renewed by BullMQ while the tick's own wall-clock budget bounds the work. */
@Processor(DOMAIN_VERIFICATION_SWEEP_QUEUE, {
  concurrency: 1,
  lockDuration: DOMAIN_VERIFICATION_SWEEP_LOCK_MS,
})
export class DomainVerificationSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(DomainVerificationSweepProcessor.name);

  constructor(private readonly sweepService: DomainVerificationSweepService) {
    super();
  }

  async process(job: Job<DomainVerificationSweepJobPayload>): Promise<void> {
    this.logger.log({ jobId: job.id }, 'Processing domain-verification-sweep job');
    const result = await this.sweepService.run();
    this.logger.log(
      { jobId: job.id, ...result },
      'domain-verification-sweep tick finished',
    );
  }
}
