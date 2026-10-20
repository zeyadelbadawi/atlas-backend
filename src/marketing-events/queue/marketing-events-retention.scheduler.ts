/**
 * Registers the marketing-beacon retention prune (aggregate rows older
 * than 25 months) as ONE BullMQ repeatable job, following
 * `PlatformContactRetentionScheduler` exactly: a fixed `jobId` with
 * identical `repeat` options is idempotent across boots and instances.
 * Registered whatever `MARKETING_EVENTS_ENABLED` says — switching
 * ingestion off must not stop old rows from expiring.
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  MKT_RETENTION_INTERVAL_MS,
  MKT_RETENTION_JOB,
  MKT_RETENTION_QUEUE,
  MKT_RETENTION_REPEAT_JOB_ID,
} from '../marketing-events.vocabulary';

@Injectable()
export class MarketingEventsRetentionScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(MarketingEventsRetentionScheduler.name);

  constructor(@InjectQueue(MKT_RETENTION_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.add(
      MKT_RETENTION_JOB,
      {},
      {
        repeat: { every: MKT_RETENTION_INTERVAL_MS },
        jobId: MKT_RETENTION_REPEAT_JOB_ID,
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
      },
    );
    this.logger.log(
      { intervalMs: MKT_RETENTION_INTERVAL_MS },
      'Registered recurring marketing-beacon retention job.',
    );
  }
}
