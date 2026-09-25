import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { AnnouncementFanOutService } from '../services/announcement-fanout.service';
import {
  ANNOUNCEMENT_FANOUT_JOB,
  ANNOUNCEMENT_FANOUT_QUEUE,
  AnnouncementFanOutJobPayload,
} from './announcement-fanout.types';

/** The ONLY processor on `announcement-fanout`. */
@Processor(ANNOUNCEMENT_FANOUT_QUEUE)
export class AnnouncementFanOutProcessor extends WorkerHost {
  private readonly logger = new Logger(AnnouncementFanOutProcessor.name);

  constructor(private readonly fanOut: AnnouncementFanOutService) {
    super();
  }

  async process(job: Job<AnnouncementFanOutJobPayload>): Promise<void> {
    if (job.name !== ANNOUNCEMENT_FANOUT_JOB) {
      throw new Error(`Unknown job "${job.name}" on ${ANNOUNCEMENT_FANOUT_QUEUE}.`);
    }
    const emitted = await this.fanOut.run(job.data);
    this.logger.log(
      { jobId: job.id, announcementId: job.data.announcementId, emitted },
      'Announcement fan-out complete.',
    );
  }
}
