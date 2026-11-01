/** Registers the ONE recurring due-reminder job, exactly like `LiveSessionSweepScheduler`. */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  DUE_REMINDER_SWEEP_INTERVAL_MS,
  DUE_REMINDER_SWEEP_JOB,
  DUE_REMINDER_SWEEP_QUEUE,
  DUE_REMINDER_SWEEP_REPEAT_JOB_ID,
  type DueReminderSweepJobPayload,
} from './due-reminder.types';

@Injectable()
export class DueReminderSweepScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(DueReminderSweepScheduler.name);

  constructor(
    @InjectQueue(DUE_REMINDER_SWEEP_QUEUE)
    private readonly queue: Queue<DueReminderSweepJobPayload>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.add(
      DUE_REMINDER_SWEEP_JOB,
      {},
      {
        repeat: { every: DUE_REMINDER_SWEEP_INTERVAL_MS },
        jobId: DUE_REMINDER_SWEEP_REPEAT_JOB_ID,
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
      },
    );
    this.logger.log(
      { intervalMs: DUE_REMINDER_SWEEP_INTERVAL_MS },
      'Registered recurring due-reminder-sweep job.',
    );
  }
}
