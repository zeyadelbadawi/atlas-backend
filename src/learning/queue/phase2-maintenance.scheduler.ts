/**
 * Registers the P64 Phase 2 maintenance sweep as ONE BullMQ repeatable
 * job, following `SubscriptionSweepScheduler` exactly — including its
 * reason: this codebase uses BullMQ's own `repeat` option and
 * deliberately does not add `@nestjs/schedule` beside it.
 *
 * `queue.add` with a fixed `jobId` and identical `repeat` options is
 * idempotent: BullMQ deduplicates by the repeat key, so registering on
 * every boot — including every instance of a multi-instance deployment —
 * never accumulates duplicate recurring jobs.
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PHASE2_MAINTENANCE_INTERVAL_MS,
  PHASE2_MAINTENANCE_JOB,
  PHASE2_MAINTENANCE_QUEUE,
  PHASE2_MAINTENANCE_REPEAT_JOB_ID,
  Phase2MaintenanceJobPayload,
} from './phase2-maintenance.types';

@Injectable()
export class Phase2MaintenanceScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(Phase2MaintenanceScheduler.name);

  constructor(
    @InjectQueue(PHASE2_MAINTENANCE_QUEUE)
    private readonly queue: Queue<Phase2MaintenanceJobPayload>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.add(
      PHASE2_MAINTENANCE_JOB,
      {},
      {
        repeat: { every: PHASE2_MAINTENANCE_INTERVAL_MS },
        jobId: PHASE2_MAINTENANCE_REPEAT_JOB_ID,
        removeOnComplete: true,
        // Bounded, matching every other repeatable job in this codebase.
        removeOnFail: { count: 1000 },
      },
    );
    this.logger.log(
      { intervalMs: PHASE2_MAINTENANCE_INTERVAL_MS },
      'Registered recurring P64 Phase 2 maintenance job (access-log retention, stalled-video poll).',
    );
  }
}
