import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUIZ_DEADLINE_QUEUE, type QuizDeadlineJobPayload } from './quiz-deadline.types';
import { QuizAttemptEngineService } from '../services/quiz-attempt-engine.service';

@Processor(QUIZ_DEADLINE_QUEUE, { concurrency: 4 })
export class QuizDeadlineProcessor extends WorkerHost {
  private readonly logger = new Logger(QuizDeadlineProcessor.name);

  constructor(private readonly engine: QuizAttemptEngineService) {
    super();
  }

  async process(job: Job<QuizDeadlineJobPayload>): Promise<void> {
    const { attemptId, studentId } = job.data;
    const outcome = await this.engine.finalizeOverdueAttempt(attemptId, studentId);
    this.logger.log({ attemptId, outcome }, 'Quiz deadline job processed.');
  }
}
