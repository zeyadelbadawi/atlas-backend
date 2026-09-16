import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { DomainVerificationSweepService } from '../services/domain-verification-sweep.service';
import {
  DomainVerificationSweepJobPayload,
  DOMAIN_VERIFICATION_SWEEP_QUEUE,
} from './domain-verification-sweep.types';

@Processor(DOMAIN_VERIFICATION_SWEEP_QUEUE)
export class DomainVerificationSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(DomainVerificationSweepProcessor.name);

  constructor(private readonly sweepService: DomainVerificationSweepService) {
    super();
  }

  async process(job: Job<DomainVerificationSweepJobPayload>): Promise<void> {
    this.logger.log({ jobId: job.id }, 'Processing domain-verification-sweep job');
    await this.sweepService.run();
  }
}
