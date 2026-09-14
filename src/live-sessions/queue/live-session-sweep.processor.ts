/** LiveSessionSweepProcessor — the `Worker` half. Thin, delegating all real logic to `LiveSessionSweepService`, mirroring `SubscriptionSweepProcessor`'s "thin processor, real logic in a service" shape. */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { LiveSessionSweepService } from '../services/live-session-sweep.service';
import {
  LiveSessionSweepJobPayload,
  LIVE_SESSION_SWEEP_QUEUE,
} from './live-session-sweep.types';

@Processor(LIVE_SESSION_SWEEP_QUEUE)
export class LiveSessionSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(LiveSessionSweepProcessor.name);

  constructor(private readonly sweepService: LiveSessionSweepService) {
    super();
  }

  async process(job: Job<LiveSessionSweepJobPayload>): Promise<void> {
    const result = await this.sweepService.run();
    // Counts only — never a session title, a tenant id, or a provider
    // payload. Enough to see the job is alive and doing work.
    this.logger.log({ jobId: job.id, ...result }, 'Live session sweep completed.');
  }
}
