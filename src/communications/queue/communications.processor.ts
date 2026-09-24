/**
 * The `Worker` half of the `communications` queue — the ONLY one. Thin:
 * every decision lives in `CommunicationDispatchService` (outbound) or
 * `DeliveryEventService` (inbound webhooks).
 *
 * Both directions share this class because they share the queue, and
 * BullMQ gives a job to whichever worker on a queue grabs it first
 * regardless of the job's name — so a second `@Processor` here would
 * compete for these jobs and drop the ones it does not recognise. See
 * `communications.types.ts`'s header.
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { CommunicationDispatchService } from '../services/communication-dispatch.service';
import { DeliveryEventService } from '../services/delivery-event.service';
import type { CommunicationsWebhookJobPayload } from './communications-queue.types';
import {
  COMMUNICATIONS_QUEUE,
  COMMUNICATION_DISPATCH_ATTEMPTS,
  COMMUNICATION_JOB_DIGEST,
  COMMUNICATION_JOB_DISPATCH,
  COMMUNICATION_JOB_PRUNE,
  COMMUNICATION_JOB_SWEEP,
  COMMUNICATION_JOB_WEBHOOK,
  CommunicationDispatchJobPayload,
} from './communications.types';

@Processor(COMMUNICATIONS_QUEUE, { concurrency: 4 })
export class CommunicationsProcessor extends WorkerHost {
  private readonly logger = new Logger(CommunicationsProcessor.name);

  constructor(
    private readonly dispatch: CommunicationDispatchService,
    private readonly deliveryEvents: DeliveryEventService,
  ) {
    super();
  }

  async process(
    job: Job<
      | CommunicationDispatchJobPayload
      | CommunicationsWebhookJobPayload
      | Record<string, never>
    >,
  ): Promise<void> {
    switch (job.name) {
      case COMMUNICATION_JOB_DISPATCH: {
        const { outboxId } = job.data as CommunicationDispatchJobPayload;
        const outcome = await this.dispatch.dispatch(outboxId, {
          made: job.attemptsMade,
          max: job.opts.attempts ?? COMMUNICATION_DISPATCH_ATTEMPTS,
        });
        this.logger.log({ jobId: job.id, outboxId, outcome }, 'Communication dispatched');
        return;
      }
      case COMMUNICATION_JOB_SWEEP: {
        const enqueued = await this.dispatch.sweep();
        if (enqueued > 0)
          this.logger.log({ enqueued }, 'Communication sweep re-enqueued rows');
        return;
      }
      case COMMUNICATION_JOB_DIGEST: {
        const sent = await this.dispatch.sendDueDigests();
        if (sent > 0) this.logger.log({ sent }, 'Communication digests sent');
        return;
      }
      case COMMUNICATION_JOB_PRUNE: {
        const result = await this.dispatch.prune();
        this.logger.log(
          { jobId: job.id, ...result },
          'Communication retention prune complete',
        );
        return;
      }
      case COMMUNICATION_JOB_WEBHOOK: {
        const payload = job.data as CommunicationsWebhookJobPayload;
        const outcome = await this.deliveryEvents.apply(payload);
        this.logger.log(
          {
            jobId: job.id,
            provider: payload.provider,
            event: payload.event,
            duplicate: outcome.duplicate,
            matchedDeliveries: outcome.matchedDeliveries,
            suppressed: outcome.suppressed,
          },
          'Processed email delivery webhook job',
        );
        return;
      }
      default:
        this.logger.warn(
          { jobId: job.id, name: job.name },
          'Unknown communication job ignored',
        );
    }
  }
}
