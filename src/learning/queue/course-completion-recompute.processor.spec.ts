import type { Job } from 'bullmq';
import { CourseCompletionRecomputeProcessor } from './course-completion-recompute.processor';
import {
  COURSE_COMPLETION_RECOMPUTE_BATCH_SIZE,
  COURSE_COMPLETION_RECOMPUTE_JOB,
  type CourseCompletionRecomputeJobPayload,
} from './course-completion-recompute.types';

const COURSE = 'course-1';
const ACADEMY = 'academy-1';
const ORG = 'org-1';

function job(
  name = COURSE_COMPLETION_RECOMPUTE_JOB,
): Job<CourseCompletionRecomputeJobPayload> {
  return {
    id: 'job-1',
    name,
    data: { courseId: COURSE, academyId: ACADEMY },
  } as Job<CourseCompletionRecomputeJobPayload>;
}

/** `count` enrollments `e-0000…`, served a page at a time by id cursor. */
function enrollmentRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `e-${String(i).padStart(4, '0')}`,
    studentId: `s-${String(i).padStart(4, '0')}`,
  }));
}

function build(options: {
  readonly organizationId?: string | null;
  readonly enrollments?: { id: string; studentId: string }[];
  /** Students whose academy membership is NOT active (blocked, pending...). */
  readonly inactiveStudents?: readonly string[];
}) {
  const all = options.enrollments ?? [];
  const inactive = new Set(options.inactiveStudents ?? []);
  const enrollmentFindMany = jest.fn(
    async (args: { where: { id?: { gt: string } }; take: number; orderBy?: unknown }) => {
      const after = args.where.id?.gt;
      return all.filter((row) => !after || row.id > after).slice(0, args.take);
    },
  );
  const academyStudentFindMany = jest.fn(
    async (args: { where: { userId: { in: string[] } } }) =>
      args.where.userId.in
        .filter((userId) => !inactive.has(userId))
        .map((userId) => ({ userId })),
  );
  const tx = {
    enrollment: { findMany: enrollmentFindMany },
    academyStudent: { findMany: academyStudentFindMany },
  };
  const tenancy = {
    runInTenantContext: jest.fn(
      async (_org: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    ),
  };
  const academies = {
    resolveOrganizationId: jest
      .fn()
      .mockResolvedValue(
        options.organizationId === undefined ? ORG : options.organizationId,
      ),
  };
  const completion = { recomputeInTenantContext: jest.fn().mockResolvedValue(null) };
  const processor = new CourseCompletionRecomputeProcessor(
    tenancy as never,
    academies as never,
    completion as never,
  );
  return { processor, tenancy, completion, enrollmentFindMany, academyStudentFindMany };
}

describe('CourseCompletionRecomputeProcessor', () => {
  it('recomputes every active enrollment of the course, one tenant-context recompute each', async () => {
    const enrollments = enrollmentRows(3);
    const { processor, tenancy, completion, enrollmentFindMany } = build({ enrollments });
    const summary = await processor.process(job());
    expect(summary).toEqual({ outcome: 'recomputed', enrollments: 3, failed: 0 });
    expect(tenancy.runInTenantContext).toHaveBeenCalledWith(ORG, expect.any(Function));
    expect(completion.recomputeInTenantContext.mock.calls.map((c) => c[0])).toEqual(
      enrollments.map((row) => ({ enrollmentId: row.id, academyId: ACADEMY })),
    );
    // The same "grants access right now" rule as `assertActiveEnrollment`.
    expect(enrollmentFindMany.mock.calls[0][0].where).toMatchObject({
      courseId: COURSE,
      academyId: ACADEMY,
      status: { in: ['enrolled', 'completed'] },
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
    });
  });

  it('skips learners whose academy membership is not active or is blocked', async () => {
    const enrollments = enrollmentRows(3);
    const { processor, completion, academyStudentFindMany } = build({
      enrollments,
      inactiveStudents: [enrollments[1].studentId],
    });
    const summary = await processor.process(job());
    expect(summary.enrollments).toBe(2);
    expect(
      completion.recomputeInTenantContext.mock.calls.map((c) => c[0].enrollmentId),
    ).toEqual([enrollments[0].id, enrollments[2].id]);
    expect(academyStudentFindMany.mock.calls[0][0].where).toMatchObject({
      academyId: ACADEMY,
      status: 'active',
      blockedAt: null,
    });
  });

  it('lists a large course in bounded, cursor-ordered batches', async () => {
    const enrollments = enrollmentRows(COURSE_COMPLETION_RECOMPUTE_BATCH_SIZE * 2 + 5);
    const { processor, completion, enrollmentFindMany } = build({ enrollments });
    const summary = await processor.process(job());
    expect(summary.enrollments).toBe(enrollments.length);
    expect(enrollmentFindMany).toHaveBeenCalledTimes(3);
    for (const [args] of enrollmentFindMany.mock.calls) {
      expect(args.take).toBe(COURSE_COMPLETION_RECOMPUTE_BATCH_SIZE);
      expect(args.orderBy).toEqual({ id: 'asc' });
    }
    expect(
      new Set(
        completion.recomputeInTenantContext.mock.calls.map((c) => c[0].enrollmentId),
      ).size,
    ).toBe(enrollments.length);
  });

  it('a course with no enrollments recomputes nothing', async () => {
    const { processor, completion } = build({ enrollments: [] });
    expect(await processor.process(job())).toEqual({
      outcome: 'recomputed',
      enrollments: 0,
      failed: 0,
    });
    expect(completion.recomputeInTenantContext).not.toHaveBeenCalled();
  });

  it('an academy with no organization is skipped without a retry', async () => {
    const { processor, tenancy, completion } = build({
      organizationId: null,
      enrollments: enrollmentRows(2),
    });
    expect(await processor.process(job())).toEqual({
      outcome: 'unknown_organization',
      enrollments: 0,
      failed: 0,
    });
    expect(tenancy.runInTenantContext).not.toHaveBeenCalled();
    expect(completion.recomputeInTenantContext).not.toHaveBeenCalled();
  });

  it('one failing enrollment does not stop the rest, and the job then fails for a retry', async () => {
    const enrollments = enrollmentRows(3);
    const { processor, completion } = build({ enrollments });
    completion.recomputeInTenantContext
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValueOnce(null);
    await expect(processor.process(job())).rejects.toThrow(/1 of 3/);
    expect(completion.recomputeInTenantContext).toHaveBeenCalledTimes(3);
  });

  it('refuses an unknown job name', async () => {
    const { processor, completion } = build({ enrollments: enrollmentRows(1) });
    await expect(processor.process(job('something-else'))).rejects.toThrow(/Unknown job/);
    expect(completion.recomputeInTenantContext).not.toHaveBeenCalled();
  });
});
