import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  ANNOUNCEMENT_FANOUT_JOB,
  ANNOUNCEMENT_FANOUT_QUEUE,
  AnnouncementFanOutJobPayload,
} from './announcement-fanout.types';

@Injectable()
export class AnnouncementFanOutProducer {
  constructor(
    @InjectQueue(ANNOUNCEMENT_FANOUT_QUEUE)
    private readonly queue: Queue<AnnouncementFanOutJobPayload>,
  ) {}

  /**
   * Called INSIDE the publish transaction, so a Redis failure fails the
   * publish instead of committing an announcement nobody is told about.
   * The job therefore can start before that transaction commits (or after
   * it rolls back); the processor re-validates at execution time and
   * retries until the publish it names is visible.
   */
  async enqueue(payload: AnnouncementFanOutJobPayload): Promise<void> {
    await this.queue.add(ANNOUNCEMENT_FANOUT_JOB, payload, {
      jobId: `announcement-fanout-${payload.announcementId}-${Date.parse(payload.publishedAt)}`,
      delay: 2000,
      attempts: 8,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
