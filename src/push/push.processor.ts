import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PUSH_JOB_DELIVER, PUSH_QUEUE } from './push.constants';
import type { PushDeliverJobPayload } from './push.constants';
import { PushDeliveryService } from './push-delivery.service';

/** The ONLY worker on the `push` queue (see `one-worker-per-queue.spec.ts`). */
@Processor(PUSH_QUEUE, { concurrency: 4 })
export class PushProcessor extends WorkerHost {
  private readonly logger = new Logger(PushProcessor.name);

  constructor(private readonly delivery: PushDeliveryService) {
    super();
  }

  async process(job: Job<PushDeliverJobPayload>): Promise<void> {
    if (job.name !== PUSH_JOB_DELIVER) {
      this.logger.warn({ jobId: job.id, name: job.name }, 'Unknown push job ignored');
      return;
    }
    const outcome = await this.delivery.deliver(job.data.outboxId);
    this.logger.log(
      { jobId: job.id, outboxId: job.data.outboxId, outcome },
      'Push processed',
    );
  }
}
