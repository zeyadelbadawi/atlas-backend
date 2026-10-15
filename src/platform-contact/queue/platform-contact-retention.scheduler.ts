/**
 * Registers the B0-SUP-04 enquiry retention sweep as ONE BullMQ repeatable
 * job, following `SecurityMaintenanceScheduler` exactly: a fixed `jobId`
 * with identical `repeat` options is idempotent across boots and instances.
 * Registered whatever `FLAG_CONTACT_RETENTION_MODE` says — the schedule is
 * infrastructure, the flag is the decision (read by the service each run).
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PLATFORM_CONTACT_RETENTION_INTERVAL_MS,
  PLATFORM_CONTACT_RETENTION_JOB,
  PLATFORM_CONTACT_RETENTION_QUEUE,
  PLATFORM_CONTACT_RETENTION_REPEAT_JOB_ID,
} from '../platform-contact.constants';

@Injectable()
export class PlatformContactRetentionScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlatformContactRetentionScheduler.name);

  constructor(
    @InjectQueue(PLATFORM_CONTACT_RETENTION_QUEUE)
    private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.add(
      PLATFORM_CONTACT_RETENTION_JOB,
      {},
      {
        repeat: { every: PLATFORM_CONTACT_RETENTION_INTERVAL_MS },
        jobId: PLATFORM_CONTACT_RETENTION_REPEAT_JOB_ID,
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
      },
    );
    this.logger.log(
      { intervalMs: PLATFORM_CONTACT_RETENTION_INTERVAL_MS },
      'Registered recurring marketing-enquiry retention job.',
    );
  }
}
