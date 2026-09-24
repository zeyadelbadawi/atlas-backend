import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  COMMUNICATIONS_QUEUE,
  COMMUNICATION_DISPATCH_ATTEMPTS,
  COMMUNICATION_DISPATCH_BACKOFF_MS,
  COMMUNICATION_JOB_DISPATCH,
  CommunicationDispatchJobPayload,
  dispatchJobId,
} from './communications.types';

@Injectable()
export class CommunicationsProducer {
  private readonly logger = new Logger(CommunicationsProducer.name);

  constructor(
    @InjectQueue(COMMUNICATIONS_QUEUE)
    private readonly queue: Queue<CommunicationDispatchJobPayload>,
  ) {}

  /**
   * Never throws: the outbox row is already committed and the sweep will
   * find it, so a Redis hiccup here must not fail the business request
   * that already succeeded.
   */
  async enqueueDispatch(outboxId: string, attempts = 0): Promise<boolean> {
    try {
      await this.queue.add(
        COMMUNICATION_JOB_DISPATCH,
        { outboxId },
        {
          jobId: dispatchJobId(outboxId, attempts),
          attempts: COMMUNICATION_DISPATCH_ATTEMPTS,
          backoff: { type: 'exponential', delay: COMMUNICATION_DISPATCH_BACKOFF_MS },
          removeOnComplete: true,
          // Exhausted jobs stay visible — the dead-letter set an alert reads.
          removeOnFail: false,
        },
      );
      return true;
    } catch (error) {
      this.logger.warn(
        { outboxId, error: error instanceof Error ? error.message : String(error) },
        'Could not enqueue communication dispatch; the sweep will pick the row up.',
      );
      return false;
    }
  }
}
