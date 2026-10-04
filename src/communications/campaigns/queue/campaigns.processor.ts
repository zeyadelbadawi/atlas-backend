/**
 * The ONLY worker on `communication-campaigns`. Thin: every decision lives
 * in `CampaignWorkerService`.
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { CampaignWorkerService } from '../campaign-worker.service';
import {
  CAMPAIGNS_QUEUE,
  CAMPAIGN_JOB_RUN,
  CAMPAIGN_JOB_TICK,
  type CampaignRunJobPayload,
} from './campaigns.types';

@Processor(CAMPAIGNS_QUEUE, { concurrency: 2 })
export class CampaignsProcessor extends WorkerHost {
  private readonly logger = new Logger(CampaignsProcessor.name);

  constructor(private readonly campaigns: CampaignWorkerService) {
    super();
  }

  async process(job: Job<CampaignRunJobPayload | Record<string, never>>): Promise<void> {
    switch (job.name) {
      case CAMPAIGN_JOB_RUN: {
        const { campaignId } = job.data as CampaignRunJobPayload;
        const outcome = await this.campaigns.run(campaignId);
        this.logger.log({ jobId: job.id, campaignId, outcome }, 'Campaign run finished');
        return;
      }
      case CAMPAIGN_JOB_TICK: {
        const advanced = await this.campaigns.tick();
        if (advanced > 0)
          this.logger.log({ advanced }, 'Campaign tick advanced campaigns');
        return;
      }
      default:
        this.logger.warn(
          { jobId: job.id, name: job.name },
          'Unknown campaign job ignored',
        );
    }
  }
}
