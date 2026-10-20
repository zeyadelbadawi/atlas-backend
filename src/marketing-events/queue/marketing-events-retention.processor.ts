/** The `Worker` half of the marketing-beacon retention prune — thin; the work lives in `MarketingEventsService.prune`. */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { MarketingEventsService } from '../marketing-events.service';
import { MKT_RETENTION_QUEUE } from '../marketing-events.vocabulary';

@Processor(MKT_RETENTION_QUEUE)
export class MarketingEventsRetentionProcessor extends WorkerHost {
  private readonly logger = new Logger(MarketingEventsRetentionProcessor.name);

  constructor(private readonly service: MarketingEventsService) {
    super();
  }

  async process(job: Job): Promise<void> {
    const result = await this.service.prune();
    this.logger.log(
      { jobId: job.id, ...result },
      'Marketing beacon retention prune complete',
    );
  }
}
