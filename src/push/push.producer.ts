import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import {
  PUSH_DELIVER_ATTEMPTS,
  PUSH_JOB_DELIVER,
  PUSH_JOB_KEEP_COMPLETED_SECONDS,
  PUSH_QUEUE,
  pushJobId,
} from './push.constants';
import type { PushDeliverJobPayload } from './push.constants';

@Injectable()
export class PushProducer {
  private readonly logger = new Logger(PushProducer.name);

  constructor(
    @InjectQueue(PUSH_QUEUE) private readonly queue: Queue<PushDeliverJobPayload>,
    private readonly config: ConfigService,
  ) {}

  /**
   * Never throws and never blocks the email dispatch that calls it. With
   * `FLAG_PUSH_MODE` off nothing is queued at all. One job per outbox row
   * (`jobId`), kept for a day after it completes so a dispatch retry is a
   * no-op instead of a second push.
   */
  async enqueue(outboxId: string): Promise<void> {
    if (this.config.get<string>('FLAG_PUSH_MODE') !== 'on') return;
    try {
      await this.queue.add(
        PUSH_JOB_DELIVER,
        { outboxId },
        {
          jobId: pushJobId(outboxId),
          attempts: PUSH_DELIVER_ATTEMPTS,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: { age: PUSH_JOB_KEEP_COMPLETED_SECONDS },
          removeOnFail: { age: 7 * PUSH_JOB_KEEP_COMPLETED_SECONDS },
        },
      );
    } catch (error) {
      this.logger.warn(
        { outboxId, error: error instanceof Error ? error.message : String(error) },
        'Could not enqueue a push; the in-app notification is unaffected.',
      );
    }
  }
}
