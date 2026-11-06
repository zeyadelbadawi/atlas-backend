/**
 * The authoring writes in `LearningModule` that can change learners'
 * course completion — quiz and assignment create/update/delete and the
 * completion rule — queue the course's completion fan-out ONLY when
 * something learner completion reads actually changed, and only AFTER
 * their transaction has returned (committed). Everything below the
 * services is mocked; the predicate itself is pinned in
 * `course-completion-recompute.types.spec.ts`.
 */
import { QuizzesService } from './quizzes.service';
import { AssignmentsService } from './assignments.service';
import { CourseCompletionService } from './course-completion.service';

const USER = 'user-1';
const COURSE = 'course-1';
const ACADEMY = 'academy-1';
const ORG = 'org-1';

/**
 * A transaction stand-in: `tx.<model>.<method>` is a jest mock created on
 * first use, resolving to `null` ("no such row") unless the test
 * configured it.
 */
function fakeTx(): Record<string, Record<string, jest.Mock>> {
  const models = new Map<string, Record<string, jest.Mock>>();
  return new Proxy({} as Record<string, Record<string, jest.Mock>>, {
    get(_target, model: string) {
      if (!models.has(model)) {
        const methods = new Map<string, jest.Mock>();
        models.set(
          model,
          new Proxy({} as Record<string, jest.Mock>, {
            get(_inner, method: string) {
              if (!methods.has(method)) {
                methods.set(method, jest.fn().mockResolvedValue(null));
              }
              return methods.get(method);
            },
          }),
        );
      }
      return models.get(model);
    },
  });
}

/**
 * Tenancy stand-in that records whether a transaction callback (possibly a
 * nested one) is still running, so a test can prove the enqueue happened
 * after the transaction returned.
 */
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
    service: {
      runInUserContext: run,
      runInTenantContext: run,
      runInTenantAndUserContext: run,
    },
  };
}

function fakeProducer(state: { readonly inTransaction: boolean }) {
  const enqueuedInTransaction: boolean[] = [];
  const enqueue = jest.fn(async () => {
    enqueuedInTransaction.push(state.inTransaction);
  });
  return { producer: { enqueue }, enqueue, enqueuedInTransaction };
}

/** Repositories every authoring path's access check reads. */
function authoringAccess() {
  return {
    coursesRepository: {
      findById: jest.fn().mockResolvedValue({ id: COURSE, academyId: ACADEMY }),
    },
    academyMembersRepository: {
      findForUserInAcademy: jest.fn().mockResolvedValue({ role: 'owner' }),
      findManagingRole: jest.fn().mockResolvedValue('owner'),
    },
    courseInstructorsRepository: { isInstructor: jest.fn().mockResolvedValue(false) },
    academiesRepository: { resolveOrganizationId: jest.fn().mockResolvedValue(ORG) },
    auditLogWriterService: {
      write: jest.fn().mockResolvedValue(undefined),
      record: jest.fn().mockResolvedValue(undefined),
    },
  };
}

const counted = { status: 'published', sectionId: 'unit-1', requiredForCompletion: true };

function quizRow(over: Record<string, unknown> = {}) {
  return {
    id: 'quiz-1',
    courseId: COURSE,
    title: 'Quiz',
    description: null,
    order: 0,
    passingScore: 50,
    maxAttempts: null,
    availableFrom: null,
    availableUntil: null,
    dueAt: null,
    questionsPerAttempt: null,
    timeLimitSeconds: null,
    mode: 'practice',
    questions: [],
    ...counted,
    ...over,
  };
}

describe('QuizzesService — completion fan-out triggers', () => {
  function build() {
    const tx = fakeTx();
    const tenancy = fakeTenancy(tx);
    const { producer, enqueue, enqueuedInTransaction } = fakeProducer(tenancy.state);
    const access = authoringAccess();
    const quizzesRepository = {
      findAnyByIdWithQuestions: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      create: jest.fn(),
      replaceQuestions: jest.fn(),
    };
    const service = new QuizzesService(
      tenancy.service as never,
      {} as never, // enrollmentsRepository
      {} as never, // academyStudentsRepository
      access.courseInstructorsRepository as never,
      access.coursesRepository as never,
      access.academyMembersRepository as never,
      access.academiesRepository as never,
      quizzesRepository as never,
      {} as never, // quizAttemptsRepository
      access.auditLogWriterService as never,
      { isEnabledForAcademy: () => true } as never,
      producer as never,
    );
    return { service, quizzesRepository, enqueue, enqueuedInTransaction };
  }

  it('detaching a counted quiz (sectionId: null) enqueues the course once, after the transaction', async () => {
    const { service, quizzesRepository, enqueue, enqueuedInTransaction } = build();
    quizzesRepository.findAnyByIdWithQuestions
      .mockResolvedValueOnce(quizRow())
      .mockResolvedValueOnce(quizRow({ sectionId: null }));
    await service.updateQuiz(USER, COURSE, 'quiz-1', { sectionId: null });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(COURSE, ACADEMY);
    expect(enqueuedInTransaction).toEqual([false]);
  });

  it.each([
    ['unpublishing a counted quiz', { status: 'draft' }],
    [
      'clearing requiredForCompletion on a counted quiz',
      { requiredForCompletion: false },
    ],
  ])('%s enqueues', async (_label, after) => {
    const { service, quizzesRepository, enqueue } = build();
    quizzesRepository.findAnyByIdWithQuestions
      .mockResolvedValueOnce(quizRow())
      .mockResolvedValueOnce(quizRow(after));
    await service.updateQuiz(USER, COURSE, 'quiz-1', after as never);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('a title edit (nothing completion reads) enqueues nothing', async () => {
    const { service, quizzesRepository, enqueue } = build();
    quizzesRepository.findAnyByIdWithQuestions
      .mockResolvedValueOnce(quizRow())
      .mockResolvedValueOnce(quizRow({ title: 'Renamed' }));
    await service.updateQuiz(USER, COURSE, 'quiz-1', { title: 'Renamed' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a failed update enqueues nothing', async () => {
    const { service, quizzesRepository, enqueue } = build();
    quizzesRepository.findAnyByIdWithQuestions.mockResolvedValueOnce(null);
    await expect(
      service.updateQuiz(USER, COURSE, 'quiz-1', { sectionId: null }),
    ).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('deleting a counted quiz enqueues; deleting a draft does not', async () => {
    const counted = build();
    counted.quizzesRepository.findAnyByIdWithQuestions.mockResolvedValueOnce(quizRow());
    await counted.service.deleteQuiz(USER, COURSE, 'quiz-1');
    expect(counted.enqueue).toHaveBeenCalledWith(COURSE, ACADEMY);
    expect(counted.enqueuedInTransaction).toEqual([false]);

    const draft = build();
    draft.quizzesRepository.findAnyByIdWithQuestions.mockResolvedValueOnce(
      quizRow({ status: 'draft' }),
    );
    await draft.service.deleteQuiz(USER, COURSE, 'quiz-1');
    expect(draft.enqueue).not.toHaveBeenCalled();
  });

  it('creating a published, placed quiz enqueues; an unplaced one does not', async () => {
    const placed = build();
    placed.quizzesRepository.create.mockResolvedValueOnce(quizRow());
    await placed.service.createQuiz(USER, COURSE, {
      title: 'Quiz',
      questions: [],
    } as never);
    expect(placed.enqueue).toHaveBeenCalledWith(COURSE, ACADEMY);

    const unplaced = build();
    unplaced.quizzesRepository.create.mockResolvedValueOnce(quizRow({ sectionId: null }));
    await unplaced.service.createQuiz(USER, COURSE, {
      title: 'Quiz',
      questions: [],
    } as never);
    expect(unplaced.enqueue).not.toHaveBeenCalled();
  });
});

describe('AssignmentsService — completion fan-out triggers', () => {
  function build() {
    const tx = fakeTx();
    const tenancy = fakeTenancy(tx);
    const { producer, enqueue, enqueuedInTransaction } = fakeProducer(tenancy.state);
    const access = authoringAccess();
    const assignmentsRepository = {
      findAnyById: jest.fn(),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      create: jest.fn(),
    };
    const service = new AssignmentsService(
      tenancy.service as never,
      {} as never, // enrollmentsRepository
      access.courseInstructorsRepository as never,
      access.coursesRepository as never,
      access.academyMembersRepository as never,
      access.academiesRepository as never,
      {} as never, // academyStudentsRepository
      {} as never, // protectedMediaService
      {} as never, // contentGrantSigner
      {} as never, // courseCompletionService
      assignmentsRepository as never,
      access.auditLogWriterService as never,
      {} as never, // courseSequence
      {} as never, // opLedger
      producer as never,
    );
    return { service, assignmentsRepository, enqueue, enqueuedInTransaction };
  }

  const assignmentRow = (over: Record<string, unknown> = {}) => ({
    id: 'assignment-1',
    courseId: COURSE,
    title: 'Assignment',
    description: null,
    instructions: null,
    lessonId: null,
    dueAt: null,
    allowResubmission: false,
    latePolicy: 'block',
    order: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...counted,
    ...over,
  });

  it('publishing a placed assignment enqueues, after the transaction', async () => {
    const { service, assignmentsRepository, enqueue, enqueuedInTransaction } = build();
    assignmentsRepository.findAnyById.mockResolvedValueOnce(
      assignmentRow({ status: 'draft' }),
    );
    assignmentsRepository.update.mockResolvedValueOnce(assignmentRow());
    await service.updateAssignment(USER, COURSE, 'assignment-1', { status: 'published' });
    expect(enqueue).toHaveBeenCalledWith(COURSE, ACADEMY);
    expect(enqueuedInTransaction).toEqual([false]);
  });

  it('flipping requiredForCompletion on a counted assignment enqueues', async () => {
    const { service, assignmentsRepository, enqueue } = build();
    assignmentsRepository.findAnyById.mockResolvedValueOnce(assignmentRow());
    assignmentsRepository.update.mockResolvedValueOnce(
      assignmentRow({ requiredForCompletion: false }),
    );
    await service.updateAssignment(USER, COURSE, 'assignment-1', {
      requiredForCompletion: false,
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('moving a counted assignment to another unit, or retitling it, enqueues nothing', async () => {
    const { service, assignmentsRepository, enqueue } = build();
    assignmentsRepository.findAnyById.mockResolvedValueOnce(assignmentRow());
    assignmentsRepository.update.mockResolvedValueOnce(
      assignmentRow({ sectionId: 'unit-2', title: 'Renamed' }),
    );
    await service.updateAssignment(USER, COURSE, 'assignment-1', {
      sectionId: 'unit-2',
      title: 'Renamed',
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('deleting a counted assignment enqueues; an unplaced one does not', async () => {
    const counted = build();
    counted.assignmentsRepository.findAnyById.mockResolvedValueOnce(assignmentRow());
    await counted.service.deleteAssignment(USER, COURSE, 'assignment-1');
    expect(counted.enqueue).toHaveBeenCalledWith(COURSE, ACADEMY);

    const unplaced = build();
    unplaced.assignmentsRepository.findAnyById.mockResolvedValueOnce(
      assignmentRow({ sectionId: null }),
    );
    await unplaced.service.deleteAssignment(USER, COURSE, 'assignment-1');
    expect(unplaced.enqueue).not.toHaveBeenCalled();
  });

  it('creating a draft assignment enqueues nothing; a published, placed one does', async () => {
    const draft = build();
    draft.assignmentsRepository.create.mockResolvedValueOnce(
      assignmentRow({ status: 'draft' }),
    );
    await draft.service.createAssignment(USER, COURSE, { title: 'A' } as never);
    expect(draft.enqueue).not.toHaveBeenCalled();

    const published = build();
    published.assignmentsRepository.create.mockResolvedValueOnce(assignmentRow());
    await published.service.createAssignment(USER, COURSE, { title: 'A' } as never);
    expect(published.enqueue).toHaveBeenCalledWith(COURSE, ACADEMY);
  });
});

describe('CourseCompletionService.updateRule — completion fan-out trigger', () => {
  function build(options: {
    readonly rule?: Record<string, unknown> | null;
    /** Required, counted quiz ids before and after the writes. */
    readonly requiredQuizzes?: readonly [string[], string[]];
  }) {
    const tx = fakeTx();
    tx.course.findFirst.mockResolvedValue({
      id: COURSE,
      title: 'Course',
      completionRule: options.rule ?? null,
      certificatesEnabled: false,
      certificateMinScore: null,
      certificateTemplateId: null,
    });
    const [before, after] = options.requiredQuizzes ?? [[], []];
    let requiredReads = 0;
    tx.quiz.findMany.mockImplementation(async (args: { where: object }) => {
      if (!('requiredForCompletion' in args.where)) return []; // the staff view
      requiredReads += 1;
      return (requiredReads === 1 ? before : after).map((id) => ({ id }));
    });
    tx.assignment.findMany.mockResolvedValue([]);
    tx.courseLesson.count.mockResolvedValue(0);
    const tenancy = fakeTenancy(tx);
    const { producer, enqueue, enqueuedInTransaction } = fakeProducer(tenancy.state);
    const access = authoringAccess();
    const service = new CourseCompletionService(
      tenancy.service as never,
      access.academiesRepository as never,
      access.academyMembersRepository as never,
      {} as never, // academyStudentsRepository
      {} as never, // enrollmentsRepository
      access.auditLogWriterService as never,
      {} as never, // certificate queue
      {} as never, // communications
      producer as never,
    );
    return { service, enqueue, enqueuedInTransaction };
  }

  it('a changed requirement enqueues the course, after the transaction', async () => {
    const { service, enqueue, enqueuedInTransaction } = build({});
    await service.updateRule(ACADEMY, ORG, USER, COURSE, { lessons: 'none' } as never);
    expect(enqueue).toHaveBeenCalledWith(COURSE, ACADEMY);
    expect(enqueuedInTransaction).toEqual([false]);
  });

  it('a changed minimum overall score enqueues', async () => {
    const { service, enqueue } = build({});
    await service.updateRule(ACADEMY, ORG, USER, COURSE, {
      minOverallScore: 70,
    } as never);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('a changed set of required (counted) quizzes enqueues', async () => {
    const { service, enqueue } = build({ requiredQuizzes: [['quiz-1'], []] });
    await service.updateRule(ACADEMY, ORG, USER, COURSE, {
      requiredQuizIds: [],
    } as never);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('re-saving the same rule, or changing only certificate settings, enqueues nothing', async () => {
    const same = build({ requiredQuizzes: [['quiz-1'], ['quiz-1']] });
    await same.service.updateRule(ACADEMY, ORG, USER, COURSE, {
      lessons: 'all',
      requiredQuizIds: ['quiz-1'],
    } as never);
    expect(same.enqueue).not.toHaveBeenCalled();

    const certificateOnly = build({});
    await certificateOnly.service.updateRule(ACADEMY, ORG, USER, COURSE, {
      certificatesEnabled: true,
      certificateMinScore: 80,
    } as never);
    expect(certificateOnly.enqueue).not.toHaveBeenCalled();
  });
});
