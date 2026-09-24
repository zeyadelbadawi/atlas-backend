/** The `Worker` half of the `communications` queue. Thin: every decision lives in `CommunicationDispatchService`. */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { CommunicationDispatchService } from '../services/communication-dispatch.service';
import {
  COMMUNICATIONS_QUEUE,
  COMMUNICATION_DISPATCH_ATTEMPTS,
  COMMUNICATION_JOB_DIGEST,
  COMMUNICATION_JOB_DISPATCH,
  COMMUNICATION_JOB_PRUNE,
  COMMUNICATION_JOB_SWEEP,
  CommunicationDispatchJobPayload,
} from './communications.types';

@Processor(COMMUNICATIONS_QUEUE, { concurrency: 4 })
export class CommunicationsProcessor extends WorkerHost {
  private readonly logger = new Logger(CommunicationsProcessor.name);

  constructor(private readonly dispatch: CommunicationDispatchService) {
    super();
  }

  async process(
    job: Job<CommunicationDispatchJobPayload | Record<string, never>>,
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
      default:
        this.logger.warn(
          { jobId: job.id, name: job.name },
          'Unknown communication job ignored',
        );
    }
  }
}
