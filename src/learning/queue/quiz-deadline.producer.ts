import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  QUIZ_DEADLINE_FINALIZE_JOB,
  QUIZ_DEADLINE_QUEUE,
  quizDeadlineJobId,
  type QuizDeadlineJobPayload,
} from './quiz-deadline.types';
import { QUIZ_AUTO_SUBMIT_DELAY_SECONDS } from '../services/quiz-engine.util';

@Injectable()
export class QuizDeadlineProducer {
  private readonly logger = new Logger(QuizDeadlineProducer.name);

  constructor(@InjectQueue(QUIZ_DEADLINE_QUEUE) private readonly queue: Queue) {}

  /**
   * Best effort by design: a failure to enqueue is logged, never thrown —
   * the attempt has already been created and the sweep will finalise it.
   * Idempotent by job id, so a resumed attempt does not get a second timer.
   */
  async schedule(
    attemptId: string,
    studentId: string,
    deadlineAt: Date,
    now: Date,
  ): Promise<void> {
    const delay = Math.max(
      0,
      deadlineAt.getTime() + QUIZ_AUTO_SUBMIT_DELAY_SECONDS * 1000 - now.getTime(),
    );
    const payload: QuizDeadlineJobPayload = { attemptId, studentId };
    try {
      await this.queue.add(QUIZ_DEADLINE_FINALIZE_JOB, payload, {
        delay,
        jobId: quizDeadlineJobId(attemptId),
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: { count: 1_000 },
      });
    } catch (error) {
      // `error`, not `warn`: a scheduling failure on every attempt is how the
      // colon-in-job-id defect hid for a whole release (22 Sep 2026). The
      // maintenance sweep still finalises the attempt within ten minutes.
      this.logger.error(
        { attemptId, error: error instanceof Error ? error.message : String(error) },
        'Could not schedule the quiz deadline job; the maintenance sweep will finalise the attempt.',
      );
    }
  }
}
