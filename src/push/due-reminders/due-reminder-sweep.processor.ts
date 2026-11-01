/** The `Worker` half: thin, the logic is in `DueReminderSweepService`. */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { DueReminderSweepService } from './due-reminder-sweep.service';
import {
  DUE_REMINDER_SWEEP_QUEUE,
  type DueReminderSweepJobPayload,
} from './due-reminder.types';

@Processor(DUE_REMINDER_SWEEP_QUEUE)
export class DueReminderSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(DueReminderSweepProcessor.name);

  constructor(private readonly sweep: DueReminderSweepService) {
    super();
  }

  async process(job: Job<DueReminderSweepJobPayload>): Promise<void> {
    const result = await this.sweep.run();
    // Counts only — never a learner, an item or a token.
    this.logger.log({ jobId: job.id, ...result }, 'Due reminder sweep completed.');
  }
}
