/**
 * LiveSessionSweepScheduler — registers the ONE recurring Live Sessions
 * job, following `SubscriptionSweepScheduler` exactly.
 *
 * Same mechanism, deliberately: BullMQ's native `repeat`, a fixed
 * `jobId`, no `@nestjs/schedule`. Adding a second scheduling dependency
 * for the second recurring job in this codebase is precisely the parallel
 * system the architecture forbids.
 *
 * Registering the same id + interval on every boot is idempotent — BullMQ
 * dedupes by repeat key — so this never accumulates duplicate recurring
 * jobs across restarts or across instances in a multi-instance deployment.
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  LIVE_SESSION_SWEEP_INTERVAL_MS,
  LIVE_SESSION_SWEEP_JOB,
  LIVE_SESSION_SWEEP_QUEUE,
  LIVE_SESSION_SWEEP_REPEAT_JOB_ID,
  LiveSessionSweepJobPayload,
} from './live-session-sweep.types';

@Injectable()
export class LiveSessionSweepScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(LiveSessionSweepScheduler.name);

  constructor(
    @InjectQueue(LIVE_SESSION_SWEEP_QUEUE)
    private readonly queue: Queue<LiveSessionSweepJobPayload>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.add(
      LIVE_SESSION_SWEEP_JOB,
      {},
      {
        repeat: { every: LIVE_SESSION_SWEEP_INTERVAL_MS },
        jobId: LIVE_SESSION_SWEEP_REPEAT_JOB_ID,
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
      },
    );
    this.logger.log(
      { intervalMs: LIVE_SESSION_SWEEP_INTERVAL_MS },
      'Registered recurring live-session-sweep job.',
    );
  }
}
