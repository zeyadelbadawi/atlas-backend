/** The `Worker` half of the B0-SUP-04 enquiry retention sweep — thin; the work lives in `PlatformContactRetentionService`. */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PlatformContactRetentionService } from '../services/platform-contact-retention.service';
import { PLATFORM_CONTACT_RETENTION_QUEUE } from '../platform-contact.constants';

@Processor(PLATFORM_CONTACT_RETENTION_QUEUE)
export class PlatformContactRetentionProcessor extends WorkerHost {
  private readonly logger = new Logger(PlatformContactRetentionProcessor.name);

  constructor(private readonly retention: PlatformContactRetentionService) {
    super();
  }

  async process(job: Job): Promise<void> {
    const result = await this.retention.run();
    this.logger.log({ jobId: job.id, ...result }, 'Enquiry retention sweep complete');
  }
}
