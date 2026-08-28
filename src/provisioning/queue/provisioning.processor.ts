/**
 * ProvisioningProcessor — the `Worker` half. Thin: delegates all real
 * logic to `ProvisioningOrchestratorService.runToCompletion`, mirroring
 * `PaymentWebhookProcessor`'s identical precedent.
 *
 * A business-level step failure (a bad academy slug, a subdomain race)
 * never throws out of `runToCompletion` — the orchestrator catches it,
 * records it onto `provisioning_steps`/`provisioning_requests`, and
 * returns normally, so this job always resolves `completed` from BullMQ's
 * own point of view (`ProvisioningProducer`'s `removeOnComplete: true`
 * then frees the `jobId`, letting a customer-triggered retry re-enqueue
 * under the same id). Only a genuinely unexpected exception (e.g. the
 * database itself being unreachable) propagates here, triggering BullMQ's
 * own `attempts`/`backoff` retry of this SAME job — the correct behavior
 * for a transient infrastructure failure, distinct from a business-logic
 * provisioning failure.
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ProvisioningOrchestratorService } from '../services/provisioning-orchestrator.service';
import { PROVISIONING_QUEUE } from './provisioning.types';
import type { ProcessProvisioningJobPayload } from './provisioning.types';

@Processor(PROVISIONING_QUEUE)
export class ProvisioningProcessor extends WorkerHost {
  private readonly logger = new Logger(ProvisioningProcessor.name);

  constructor(
    private readonly provisioningOrchestratorService: ProvisioningOrchestratorService,
  ) {
    super();
  }

  async process(job: Job<ProcessProvisioningJobPayload>): Promise<void> {
    this.logger.log(
      {
        jobId: job.id,
        provisioningRequestId: job.data.provisioningRequestId,
        organizationId: job.data.organizationId,
      },
      'Processing provisioning job',
    );
    await this.provisioningOrchestratorService.runToCompletion(
      job.data.provisioningRequestId,
      job.data.organizationId,
    );
  }
}
