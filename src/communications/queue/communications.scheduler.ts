/**
 * Registers the four repeatable communication jobs, following
 * `Phase2MaintenanceScheduler` exactly: BullMQ's own `repeat` with a fixed
 * `jobId`, idempotent across boots and instances, no `@nestjs/schedule`.
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  COMMUNICATIONS_QUEUE,
  COMMUNICATION_DIGEST_INTERVAL_MS,
  COMMUNICATION_EXCEPTION_ACTIVATION_INTERVAL_MS,
  COMMUNICATION_EXCEPTION_ACTIVATION_REPEAT_JOB_ID,
  COMMUNICATION_JOB_EXCEPTION_ACTIVATION,
  COMMUNICATION_DIGEST_REPEAT_JOB_ID,
  COMMUNICATION_JOB_DIGEST,
  COMMUNICATION_JOB_PRUNE,
  COMMUNICATION_JOB_SWEEP,
  COMMUNICATION_PRUNE_INTERVAL_MS,
  COMMUNICATION_PRUNE_REPEAT_JOB_ID,
  COMMUNICATION_SWEEP_INTERVAL_MS,
  COMMUNICATION_SWEEP_REPEAT_JOB_ID,
  CommunicationRepeatJobPayload,
} from './communications.types';

@Injectable()
export class CommunicationsScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(CommunicationsScheduler.name);

  constructor(
    @InjectQueue(COMMUNICATIONS_QUEUE)
    private readonly queue: Queue<CommunicationRepeatJobPayload>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const jobs = [
      [
        COMMUNICATION_JOB_SWEEP,
        COMMUNICATION_SWEEP_REPEAT_JOB_ID,
        COMMUNICATION_SWEEP_INTERVAL_MS,
      ],
      [
        COMMUNICATION_JOB_DIGEST,
        COMMUNICATION_DIGEST_REPEAT_JOB_ID,
        COMMUNICATION_DIGEST_INTERVAL_MS,
      ],
      [
        COMMUNICATION_JOB_PRUNE,
        COMMUNICATION_PRUNE_REPEAT_JOB_ID,
        COMMUNICATION_PRUNE_INTERVAL_MS,
      ],
      [
        COMMUNICATION_JOB_EXCEPTION_ACTIVATION,
        COMMUNICATION_EXCEPTION_ACTIVATION_REPEAT_JOB_ID,
        COMMUNICATION_EXCEPTION_ACTIVATION_INTERVAL_MS,
      ],
    ] as const;
    for (const [name, jobId, every] of jobs) {
      await this.queue.add(
        name,
        {},
        {
          repeat: { every },
          jobId,
          removeOnComplete: true,
          removeOnFail: { count: 1000 },
        },
      );
    }
    this.logger.log(
      'Registered recurring communication jobs (sweep 60s, digest hourly, prune daily, exception activation 5m).',
    );
  }
}
