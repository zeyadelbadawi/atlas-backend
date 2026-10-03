import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  CAMPAIGNS_QUEUE,
  CAMPAIGN_JOB_RUN,
  campaignRunJobId,
  type CampaignRunJobPayload,
} from './campaigns.types';

@Injectable()
export class CampaignsProducer {
  private readonly logger = new Logger(CampaignsProducer.name);

  constructor(
    @InjectQueue(CAMPAIGNS_QUEUE)
    private readonly queue: Queue<CampaignRunJobPayload>,
  ) {}

  /**
   * A hint, never a requirement: the campaign row is committed and the
   * repeatable tick resumes it. Never throws, so a Redis hiccup cannot turn
   * an accepted (202) send into an error.
   */
  async enqueueRun(campaignId: string): Promise<boolean> {
    try {
      await this.queue.add(
        CAMPAIGN_JOB_RUN,
        { campaignId },
        {
          jobId: campaignRunJobId(campaignId),
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: { count: 1000 },
        },
      );
      return true;
    } catch (error) {
      this.logger.warn(
        { campaignId, error: error instanceof Error ? error.message : String(error) },
        'Could not enqueue a campaign run; the tick will resume it.',
      );
      return false;
    }
  }
}
