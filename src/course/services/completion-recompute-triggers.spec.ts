/**
 * The curriculum writes in `CourseModule` that can change learners' course
 * completion — deleting a unit (its quizzes/assignments are detached by
 * `ON DELETE SET NULL`) and attaching/detaching a quiz or assignment —
 * queue the course's completion fan-out only when a PUBLISHED item enters
 * or leaves the learner's course, and only after their transaction has
 * returned (committed).
 */
import { CourseCurriculumService } from './course-curriculum.service';
import { UnitCurriculumService } from './unit-curriculum.service';

const USER = 'user-1';
const COURSE = 'course-1';
const ACADEMY = 'academy-1';
const ORG = 'org-1';
const UNIT = 'unit-1';

/**
 * A transaction stand-in: `tx.<model>.<method>` is a jest mock created on
 * first use — `findMany` resolves to `[]`, everything else to `null`
 * unless the test configured it. `$queryRaw` (the row locks) finds the row.
 */
function fakeTx(): Record<string, Record<string, jest.Mock>> {
  const models = new Map<string, unknown>();
  return new Proxy({} as Record<string, Record<string, jest.Mock>>, {
    get(_target, model: string) {
      if (!models.has(model)) {
        if (model === '$queryRaw') {
          models.set(model, jest.fn().mockResolvedValue([{ id: 'locked' }]));
        } else {
          const methods = new Map<string, jest.Mock>();
          models.set(
            model,
            new Proxy({} as Record<string, jest.Mock>, {
              get(_inner, method: string) {
                if (!methods.has(method)) {
                  methods.set(
                    method,
                    jest.fn().mockResolvedValue(method === 'findMany' ? [] : null),
                  );
                }
                return methods.get(method);
              },
            }),
          );
        }
      }
      return models.get(model);
    },
  }) as Record<string, Record<string, jest.Mock>>;
}

function fakeTenancy(tx: unknown) {
  let depth = 0;
  const state = {
    get inTransaction() {
      return depth > 0;
    },
  };
  const run = jest.fn(async (...args: unknown[]) => {
    const fn = args[args.length - 1] as (tx: unknown) => Promise<unknown>;
    depth += 1;
    try {
      return await fn(tx);
    } finally {
      depth -= 1;
    }
  });
  return {
    state,
    service: { runInTenantContext: run, runInTenantAndUserContext: run },
  };
}

function fakeProducer(state: { readonly inTransaction: boolean }) {
  const enqueuedInTransaction: boolean[] = [];
  const enqueue = jest.fn(async () => {
    enqueuedInTransaction.push(state.inTransaction);
  });
  return { producer: { enqueue }, enqueue, enqueuedInTransaction };
}

const coursesRepository = {
  findById: jest.fn().mockResolvedValue({ id: COURSE, academyId: ACADEMY }),
};
const academyMembersRepository = {
  findManagingRole: jest.fn().mockResolvedValue('owner'),
};
const courseInstructorsRepository = { isInstructor: jest.fn().mockResolvedValue(false) };
const auditLogWriterService = { write: jest.fn().mockResolvedValue(undefined) };

describe('CourseCurriculumService.deleteSection — completion fan-out trigger', () => {
  function build(published: { quizzes: number; assignments: number }) {
    const tx = fakeTx();
    tx.quiz.count.mockResolvedValue(published.quizzes);
    tx.assignment.count.mockResolvedValue(published.assignments);
    const tenancy = fakeTenancy(tx);
    const { producer, enqueue, enqueuedInTransaction } = fakeProducer(tenancy.state);
    const sectionsRepository = {
      findById: jest
        .fn()
        .mockResolvedValue({ id: UNIT, courseId: COURSE, title: 'Unit' }),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const service = new CourseCurriculumService(
      tenancy.service as never,
      coursesRepository as never,
      sectionsRepository as never,
      {} as never, // lessonsRepository
      {} as never, // lessonContentsRepository
      academyMembersRepository as never,
      courseInstructorsRepository as never,
      auditLogWriterService as never,
      producer as never,
    );
    return { service, tx, enqueue, enqueuedInTransaction };
  }

  it('deleting a unit that holds a published quiz enqueues the course, after the transaction', async () => {
    const { service, tx, enqueue, enqueuedInTransaction } = build({
      quizzes: 1,
      assignments: 0,
    });
    await service.deleteSection(UNIT, COURSE, ACADEMY, ORG, USER);
    expect(tx.quiz.count).toHaveBeenCalledWith({
      where: { sectionId: UNIT, status: 'published' },
    });
    expect(enqueue).toHaveBeenCalledWith(COURSE, ACADEMY);
    expect(enqueuedInTransaction).toEqual([false]);
  });

  it('deleting a unit that holds a published assignment enqueues', async () => {
    const { service, enqueue } = build({ quizzes: 0, assignments: 2 });
    await service.deleteSection(UNIT, COURSE, ACADEMY, ORG, USER);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('deleting a unit with no published quiz or assignment enqueues nothing', async () => {
    const { service, enqueue } = build({ quizzes: 0, assignments: 0 });
    await service.deleteSection(UNIT, COURSE, ACADEMY, ORG, USER);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a refused delete (learner progress in the unit) enqueues nothing', async () => {
    const { service, tx, enqueue } = build({ quizzes: 1, assignments: 0 });
    tx.lessonProgress.findFirst.mockResolvedValue({ id: 'progress-1' });
    await expect(
      service.deleteSection(UNIT, COURSE, ACADEMY, ORG, USER),
    ).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('UnitCurriculumService attach/detach — completion fan-out trigger', () => {
  function build(item: { sectionId: string | null; status: string }) {
    const tx = fakeTx();
    tx.courseSection.findUnique.mockResolvedValue({
      id: UNIT,
      courseId: COURSE,
      title: 'Unit',
    });
    const row = { id: 'quiz-1', courseId: COURSE, title: 'Quiz', ...item };
    tx.quiz.findUnique.mockResolvedValue(row);
    tx.assignment.findUnique.mockResolvedValue({ ...row, id: 'assignment-1' });
    const tenancy = fakeTenancy(tx);
    const { producer, enqueue, enqueuedInTransaction } = fakeProducer(tenancy.state);
    const service = new UnitCurriculumService(
      tenancy.service as never,
      coursesRepository as never,
      academyMembersRepository as never,
      courseInstructorsRepository as never,
      auditLogWriterService as never,
      producer as never,
    );
    return { service, enqueue, enqueuedInTransaction };
  }

  it('placing a published, unplaced quiz in a unit enqueues, after the transaction', async () => {
    const { service, enqueue, enqueuedInTransaction } = build({
      sectionId: null,
      status: 'published',
    });
    await service.attachItem(COURSE, UNIT, ACADEMY, ORG, USER, {
      type: 'quiz',
      itemId: 'quiz-1',
    });
    expect(enqueue).toHaveBeenCalledWith(COURSE, ACADEMY);
    expect(enqueuedInTransaction).toEqual([false]);
  });

  it('moving a quiz between units, or placing a draft, enqueues nothing', async () => {
    const moved = build({ sectionId: 'unit-0', status: 'published' });
    await moved.service.attachItem(COURSE, UNIT, ACADEMY, ORG, USER, {
      type: 'quiz',
      itemId: 'quiz-1',
    });
    expect(moved.enqueue).not.toHaveBeenCalled();

    const draft = build({ sectionId: null, status: 'draft' });
    await draft.service.attachItem(COURSE, UNIT, ACADEMY, ORG, USER, {
      type: 'assignment',
      itemId: 'assignment-1',
    });
    expect(draft.enqueue).not.toHaveBeenCalled();
  });

  it('detaching a published assignment enqueues; detaching a draft does not', async () => {
    const published = build({ sectionId: UNIT, status: 'published' });
    await published.service.detachItem(COURSE, UNIT, ACADEMY, ORG, USER, {
      type: 'assignment',
      itemId: 'assignment-1',
    });
    expect(published.enqueue).toHaveBeenCalledWith(COURSE, ACADEMY);
    expect(published.enqueuedInTransaction).toEqual([false]);

    const draft = build({ sectionId: UNIT, status: 'draft' });
    await draft.service.detachItem(COURSE, UNIT, ACADEMY, ORG, USER, {
      type: 'quiz',
      itemId: 'quiz-1',
    });
    expect(draft.enqueue).not.toHaveBeenCalled();
  });
});
