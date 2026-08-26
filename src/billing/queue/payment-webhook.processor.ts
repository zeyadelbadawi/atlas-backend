/** PaymentWebhookProcessor — the `Worker` half. Thin: delegates all real logic to `PaymentWebhookService.processEvent`, mirroring `TenantUsageRecomputeProcessor`'s identical precedent. */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PaymentWebhookService } from '../services/payment-webhook.service';
import { PAYMENT_WEBHOOK_QUEUE } from './payment-webhook.types';
import type { ProcessWebhookEventJobPayload } from './payment-webhook.types';

@Processor(PAYMENT_WEBHOOK_QUEUE)
export class PaymentWebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentWebhookProcessor.name);

  constructor(private readonly paymentWebhookService: PaymentWebhookService) {
    super();
  }

  async process(job: Job<ProcessWebhookEventJobPayload>): Promise<void> {
    this.logger.log(
      { jobId: job.id, eventId: job.data.eventId, eventType: job.data.eventType },
      'Processing payment-webhook job',
    );
    await this.paymentWebhookService.processEvent(job.data);
  }
}
