import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import {
  COURSE_COMPLETION_RECOMPUTE_DELAY_MS,
  COURSE_COMPLETION_RECOMPUTE_JOB,
  COURSE_COMPLETION_RECOMPUTE_QUEUE,
  courseCompletionRecomputeJobId,
  type CourseCompletionRecomputeJobPayload,
} from './course-completion-recompute.types';

/** A job that has not started yet: it will read the course when it runs. */
const PENDING_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
]);

@Injectable()
export class CourseCompletionRecomputeProducer {
  private readonly logger = new Logger(CourseCompletionRecomputeProducer.name);

  constructor(
    @InjectQueue(COURSE_COMPLETION_RECOMPUTE_QUEUE)
    private readonly queue: Queue<CourseCompletionRecomputeJobPayload>,
  ) {}

  /**
   * Queues the fan-out for one course. Call it AFTER the authoring
   * transaction has committed; the delay is the second guard and the
   * window in which further edits collapse into this job.
   *
   * Same state handling as `CourseCompletionService.enqueueIssuance`: a
   * job for the course that has not started yet already covers this
   * change, so nothing is added. A job already RUNNING may have read the
   * course before this change, so a follow-up (its own deterministic id)
   * is queued instead of being swallowed. A finished job still held under
   * the id (`removeOnFail` keeps the last 1,000) would make BullMQ ignore
   * the add, so it is removed first.
   *
   * Best effort by design: a failure is logged, never thrown into the
   * authoring request — the edit is already committed, and every learner's
   * next read or write still self-heals the verdict.
   */
  async enqueue(courseId: string, academyId: string): Promise<void> {
    const payload: CourseCompletionRecomputeJobPayload = { courseId, academyId };
    try {
      const mainId = courseCompletionRecomputeJobId(courseId);
      const followupId = courseCompletionRecomputeJobId(courseId, 'followup');
      const main = await this.stateOf(mainId);
      let jobId = mainId;
      if (main && PENDING_STATES.has(main.state)) return;
      if (main?.state === 'active') {
        jobId = followupId;
        const followup = await this.stateOf(followupId);
        if (followup && followup.state !== 'completed' && followup.state !== 'failed') {
          return;
        }
        if (followup) await this.removeFinished(followup.job, followupId);
      } else {
        // No job under the main id, or only a finished one. A pending
        // follow-up (queued while the previous main job ran) covers this
        // change just as well.
        const followup = await this.stateOf(followupId);
        if (followup && PENDING_STATES.has(followup.state)) return;
        if (main) await this.removeFinished(main.job, mainId);
      }
      await this.queue.add(COURSE_COMPLETION_RECOMPUTE_JOB, payload, {
        jobId,
        delay: COURSE_COMPLETION_RECOMPUTE_DELAY_MS,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: { count: 1_000 },
      });
    } catch (error) {
      this.logger.error(
        {
          courseId,
          academyId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not enqueue the course completion recompute; learners self-heal on their next read.',
      );
    }
  }

  private async stateOf(
    jobId: string,
  ): Promise<{ job: Job<CourseCompletionRecomputeJobPayload>; state: string } | null> {
    const job = await this.queue.getJob(jobId);
    if (!job) return null;
    return { job, state: await job.getState() };
  }

  private async removeFinished(
    job: Job<CourseCompletionRecomputeJobPayload>,
    jobId: string,
  ): Promise<void> {
    try {
      await job.remove();
    } catch (error) {
      // Gone already, or locked by a worker in the meantime: the add below
      // either lands or collapses into the job that now holds the id.
      this.logger.warn(
        { jobId, error: error instanceof Error ? error.message : String(error) },
        'Could not remove a finished course completion recompute job before re-adding it.',
      );
    }
  }
}
