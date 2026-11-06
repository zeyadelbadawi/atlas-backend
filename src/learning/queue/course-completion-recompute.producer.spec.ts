import type { Queue } from 'bullmq';
import { CourseCompletionRecomputeProducer } from './course-completion-recompute.producer';
import {
  COURSE_COMPLETION_RECOMPUTE_DELAY_MS,
  COURSE_COMPLETION_RECOMPUTE_JOB,
  courseCompletionRecomputeJobId,
  type CourseCompletionRecomputeJobPayload,
} from './course-completion-recompute.types';

const COURSE = 'course-1';
const ACADEMY = 'academy-1';
const MAIN_ID = courseCompletionRecomputeJobId(COURSE);
const FOLLOWUP_ID = courseCompletionRecomputeJobId(COURSE, 'followup');

/** A queue holding jobs in the given states, keyed by job id. */
function fakeQueue(states: Record<string, string> = {}) {
  const jobs = new Map(
    Object.entries(states).map(([id, state]) => [
      id,
      {
        id,
        getState: jest.fn().mockResolvedValue(state),
        remove: jest.fn().mockResolvedValue(undefined),
      },
    ]),
  );
  const queue = {
    getJob: jest.fn(async (id: string) => jobs.get(id)),
    add: jest.fn().mockResolvedValue(undefined),
  };
  return { queue, jobs };
}

const producer = (queue: unknown) =>
  new CourseCompletionRecomputeProducer(
    queue as Queue<CourseCompletionRecomputeJobPayload>,
  );

describe('CourseCompletionRecomputeProducer', () => {
  it('adds one delayed job for the course under its fixed, colon-free id', async () => {
    const { queue } = fakeQueue();
    await producer(queue).enqueue(COURSE, ACADEMY);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      COURSE_COMPLETION_RECOMPUTE_JOB,
      { courseId: COURSE, academyId: ACADEMY },
      expect.objectContaining({
        jobId: MAIN_ID,
        delay: COURSE_COMPLETION_RECOMPUTE_DELAY_MS,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: { count: 1_000 },
      }),
    );
    expect(queue.add.mock.calls[0][2].jobId).not.toContain(':');
    expect(COURSE_COMPLETION_RECOMPUTE_DELAY_MS).toBeGreaterThan(0);
  });

  it.each(['waiting', 'delayed', 'prioritized'])(
    'adds nothing while a %s job for the course already covers the change (a burst collapses)',
    async (state) => {
      const { queue, jobs } = fakeQueue({ [MAIN_ID]: state });
      await producer(queue).enqueue(COURSE, ACADEMY);
      expect(queue.add).not.toHaveBeenCalled();
      expect(jobs.get(MAIN_ID)!.remove).not.toHaveBeenCalled();
    },
  );

  it('queues a follow-up when the course job is already running (it may have read the course before this edit)', async () => {
    const { queue } = fakeQueue({ [MAIN_ID]: 'active' });
    await producer(queue).enqueue(COURSE, ACADEMY);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][2]).toMatchObject({ jobId: FOLLOWUP_ID });
    expect(FOLLOWUP_ID).not.toContain(':');
  });

  it.each(['waiting', 'delayed', 'active'])(
    'adds no second follow-up while one is %s',
    async (state) => {
      const { queue } = fakeQueue({ [MAIN_ID]: 'active', [FOLLOWUP_ID]: state });
      await producer(queue).enqueue(COURSE, ACADEMY);
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it('replaces a finished follow-up while the course job runs', async () => {
    const { queue, jobs } = fakeQueue({ [MAIN_ID]: 'active', [FOLLOWUP_ID]: 'failed' });
    await producer(queue).enqueue(COURSE, ACADEMY);
    expect(jobs.get(FOLLOWUP_ID)!.remove).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][2]).toMatchObject({ jobId: FOLLOWUP_ID });
  });

  it('adds nothing when no course job exists but a follow-up is still pending', async () => {
    const { queue } = fakeQueue({ [FOLLOWUP_ID]: 'delayed' });
    await producer(queue).enqueue(COURSE, ACADEMY);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each(['failed', 'completed'])(
    'removes a %s job held under the id before re-adding it (BullMQ would ignore the add)',
    async (state) => {
      const { queue, jobs } = fakeQueue({ [MAIN_ID]: state });
      await producer(queue).enqueue(COURSE, ACADEMY);
      const remove = jobs.get(MAIN_ID)!.remove;
      expect(remove).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(remove.mock.invocationCallOrder[0]).toBeLessThan(
        queue.add.mock.invocationCallOrder[0],
      );
      expect(queue.add.mock.calls[0][2]).toMatchObject({ jobId: MAIN_ID });
    },
  );

  it('still adds when removing the finished job races (locked or already gone)', async () => {
    const { queue, jobs } = fakeQueue({ [MAIN_ID]: 'failed' });
    jobs.get(MAIN_ID)!.remove.mockRejectedValue(new Error('Job is locked'));
    await expect(producer(queue).enqueue(COURSE, ACADEMY)).resolves.toBeUndefined();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('is best effort: a Redis failure is logged, never thrown into the authoring request', async () => {
    const { queue } = fakeQueue();
    queue.add.mockRejectedValue(new Error('Connection is closed.'));
    await expect(producer(queue).enqueue(COURSE, ACADEMY)).resolves.toBeUndefined();

    const { queue: broken } = fakeQueue();
    broken.getJob.mockRejectedValue(new Error('Connection is closed.'));
    await expect(producer(broken).enqueue(COURSE, ACADEMY)).resolves.toBeUndefined();
    expect(broken.add).not.toHaveBeenCalled();
  });
});
