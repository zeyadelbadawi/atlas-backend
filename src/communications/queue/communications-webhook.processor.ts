/** CommunicationsWebhookProcessor — the `Worker` half; delegates to `DeliveryEventService`, mirroring `PaymentWebhookProcessor`. */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { DeliveryEventService } from '../services/delivery-event.service';
import {
  COMMUNICATIONS_QUEUE,
  COMMUNICATIONS_WEBHOOK_JOB,
  type CommunicationsWebhookJobPayload,
} from './communications-queue.types';

@Processor(COMMUNICATIONS_QUEUE)
export class CommunicationsWebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(CommunicationsWebhookProcessor.name);

  constructor(private readonly deliveryEvents: DeliveryEventService) {
    super();
  }

  async process(job: Job<CommunicationsWebhookJobPayload>): Promise<void> {
    if (job.name !== COMMUNICATIONS_WEBHOOK_JOB) return;
    const outcome = await this.deliveryEvents.apply(job.data);
    this.logger.log(
      {
        jobId: job.id,
        provider: job.data.provider,
        event: job.data.event,
        duplicate: outcome.duplicate,
        matchedDeliveries: outcome.matchedDeliveries,
        suppressed: outcome.suppressed,
      },
      'Processed email delivery webhook job',
    );
  }
}
