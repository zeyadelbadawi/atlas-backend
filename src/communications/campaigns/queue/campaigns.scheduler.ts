/** Registers the repeatable campaign tick — the `CommunicationsScheduler` pattern. */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  CAMPAIGNS_QUEUE,
  CAMPAIGN_JOB_TICK,
  CAMPAIGN_TICK_INTERVAL_MS,
  CAMPAIGN_TICK_REPEAT_JOB_ID,
} from './campaigns.types';

@Injectable()
export class CampaignsScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(CampaignsScheduler.name);

  constructor(@InjectQueue(CAMPAIGNS_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.add(
      CAMPAIGN_JOB_TICK,
      {},
      {
        repeat: { every: CAMPAIGN_TICK_INTERVAL_MS },
        jobId: CAMPAIGN_TICK_REPEAT_JOB_ID,
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
      },
    );
    this.logger.log('Registered the recurring campaign tick (30s).');
  }
}
