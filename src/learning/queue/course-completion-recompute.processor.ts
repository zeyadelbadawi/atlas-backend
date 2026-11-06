import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademiesRepository } from '../../academy/repositories/academies.repository';
import { CourseCompletionService } from '../services/course-completion.service';
import { ACTIVE_ENROLLMENT_STATUSES } from '../dto/learning.constants';
import {
  COURSE_COMPLETION_RECOMPUTE_BATCH_SIZE,
  COURSE_COMPLETION_RECOMPUTE_CONCURRENCY,
  COURSE_COMPLETION_RECOMPUTE_JOB,
  COURSE_COMPLETION_RECOMPUTE_QUEUE,
  type CourseCompletionRecomputeJobPayload,
} from './course-completion-recompute.types';

export interface CourseCompletionRecomputeSummary {
  readonly outcome: 'recomputed' | 'unknown_organization';
  readonly enrollments: number;
  readonly failed: number;
}

/** The ONLY processor on `course-completion-recompute`. */
@Processor(COURSE_COMPLETION_RECOMPUTE_QUEUE, {
  concurrency: COURSE_COMPLETION_RECOMPUTE_CONCURRENCY,
})
export class CourseCompletionRecomputeProcessor extends WorkerHost {
  private readonly logger = new Logger(CourseCompletionRecomputeProcessor.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academiesRepository: AcademiesRepository,
    private readonly courseCompletionService: CourseCompletionService,
  ) {
    super();
  }

  /**
   * Recomputes every ACTIVE enrollment of the course — the same rule
   * `assertActiveEnrollment` applies before a learner's own recompute
   * (status enrolled/completed, not revoked, not expired, an active and
   * unblocked academy membership). `completed` enrollments are included:
   * an added requirement can take completion away again, exactly as the
   * learner's own next read would.
   *
   * Each enrollment is its own tenant-context transaction
   * (`recomputeInTenantContext`, which also hands the course.completed
   * outbox row to the dispatcher after commit), so a large course never
   * holds one long transaction. One failing enrollment does not stop the
   * rest; the job then fails so BullMQ retries it — `recompute` is
   * idempotent, so the enrollments that already succeeded are untouched.
   */
  async process(
    job: Job<CourseCompletionRecomputeJobPayload>,
  ): Promise<CourseCompletionRecomputeSummary> {
    if (job.name !== COURSE_COMPLETION_RECOMPUTE_JOB) {
      throw new Error(
        `Unknown job "${job.name}" on ${COURSE_COMPLETION_RECOMPUTE_QUEUE}.`,
      );
    }
    const { courseId, academyId } = job.data;
    const organizationId =
      await this.academiesRepository.resolveOrganizationId(academyId);
    if (!organizationId) {
      // The academy is gone (or never existed): nothing to recompute, and
      // retrying would not change that.
      this.logger.warn(
        { jobId: job.id, courseId, academyId },
        'Course completion recompute skipped: the academy has no organization.',
      );
      return { outcome: 'unknown_organization', enrollments: 0, failed: 0 };
    }

    let enrollments = 0;
    let failed = 0;
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.nextEnrollmentIds(
        organizationId,
        courseId,
        academyId,
        cursor,
      );
      for (const enrollmentId of batch.recompute) {
        enrollments += 1;
        try {
          await this.courseCompletionService.recomputeInTenantContext({
            enrollmentId,
            academyId,
          });
        } catch (error) {
          failed += 1;
          this.logger.warn(
            {
              jobId: job.id,
              courseId,
              enrollmentId,
              error: error instanceof Error ? error.message : String(error),
            },
            'Course completion recompute failed for one enrollment.',
          );
        }
      }
      if (batch.lastId === null) break;
      cursor = batch.lastId;
    }

    this.logger.log(
      { jobId: job.id, courseId, academyId, enrollments, failed },
      'Course completion recompute complete.',
    );
    if (failed > 0) {
      throw new Error(
        `Course completion recompute failed for ${failed} of ${enrollments} enrollments of course ${courseId}.`,
      );
    }
    return { outcome: 'recomputed', enrollments, failed };
  }

  /**
   * One page of the course's active enrollments, ordered by id so the
   * cursor is stable. `lastId` is null once the listing is exhausted.
   */
  private nextEnrollmentIds(
    organizationId: string,
    courseId: string,
    academyId: string,
    cursor: string | undefined,
  ): Promise<{ recompute: string[]; lastId: string | null }> {
    const now = new Date();
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const rows = await tx.enrollment.findMany({
        where: {
          courseId,
          academyId,
          status: { in: [...ACTIVE_ENROLLMENT_STATUSES] },
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, studentId: true },
        orderBy: { id: 'asc' },
        take: COURSE_COMPLETION_RECOMPUTE_BATCH_SIZE,
      });
      if (rows.length === 0) return { recompute: [], lastId: null };
      const members = await tx.academyStudent.findMany({
        where: {
          academyId,
          userId: { in: rows.map((row) => row.studentId) },
          status: 'active',
          blockedAt: null,
        },
        select: { userId: true },
      });
      const activeMembers = new Set(members.map((member) => member.userId));
      return {
        recompute: rows
          .filter((row) => activeMembers.has(row.studentId))
          .map((row) => row.id),
        lastId:
          rows.length < COURSE_COMPLETION_RECOMPUTE_BATCH_SIZE
            ? null
            : rows[rows.length - 1].id,
      };
    });
  }
}
