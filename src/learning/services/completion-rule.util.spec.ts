import {
  DEFAULT_COMPLETION_RULE,
  evaluateCompletion,
  parseCompletionRule,
  type AssignmentEvidence,
  type QuizEvidence,
} from './completion-rule.util';

const quiz = (over: Partial<QuizEvidence> = {}): QuizEvidence => ({
  quizId: 'q1',
  title: 'Quiz 1.2',
  required: true,
  passed: false,
  effectiveScore: null,
  pendingGrading: false,
  ...over,
});
const assignment = (over: Partial<AssignmentEvidence> = {}): AssignmentEvidence => ({
  assignmentId: 'a1',
  title: 'Essay',
  required: true,
  submitted: false,
  graded: false,
  score: null,
  ...over,
});

describe('completion rule — parsing', () => {
  it("defaults to today's rule for anything malformed", () => {
    expect(parseCompletionRule(null)).toEqual(DEFAULT_COMPLETION_RULE);
    expect(parseCompletionRule({ lessons: 'weird', minOverallScore: 500 })).toEqual(
      DEFAULT_COMPLETION_RULE,
    );
  });

  it('accepts a lesson count and a bounded minimum score', () => {
    expect(
      parseCompletionRule({ lessons: 3, minOverallScore: 70, requiredQuizzes: false }),
    ).toEqual({
      lessons: 3,
      requiredQuizzes: false,
      requiredAssignments: true,
      minOverallScore: 70,
    });
  });
});

describe('completion rule — evaluator', () => {
  it('lessons only: complete when every lesson is done, and never for an empty course', () => {
    expect(
      evaluateCompletion(DEFAULT_COMPLETION_RULE, { total: 3, completed: 3 }, [], [])
        .completed,
    ).toBe(true);
    const partial = evaluateCompletion(
      DEFAULT_COMPLETION_RULE,
      { total: 3, completed: 1 },
      [],
      [],
    );
    expect(partial.completed).toBe(false);
    expect(partial.missing).toEqual([
      { kind: 'lessons', id: null, title: null, detail: 2 },
    ]);
    expect(
      evaluateCompletion(DEFAULT_COMPLETION_RULE, { total: 0, completed: 0 }, [], [])
        .completed,
    ).toBe(false);
  });

  it('a required quiz blocks completion until passed; pending grading is named as such', () => {
    const notPassed = evaluateCompletion(
      DEFAULT_COMPLETION_RULE,
      { total: 1, completed: 1 },
      [quiz()],
      [],
    );
    expect(notPassed.completed).toBe(false);
    expect(notPassed.missing[0]).toMatchObject({
      kind: 'quiz_not_passed',
      id: 'q1',
      title: 'Quiz 1.2',
    });

    const pending = evaluateCompletion(
      DEFAULT_COMPLETION_RULE,
      { total: 1, completed: 1 },
      [quiz({ pendingGrading: true })],
      [],
    );
    expect(pending.missing[0].kind).toBe('quiz_pending_grading');

    const passed = evaluateCompletion(
      DEFAULT_COMPLETION_RULE,
      { total: 1, completed: 1 },
      [quiz({ passed: true, effectiveScore: 80 })],
      [],
    );
    expect(passed.completed).toBe(true);
    expect(passed.overallScore).toBe(80);
  });

  it('an optional quiz never blocks', () => {
    const result = evaluateCompletion(
      DEFAULT_COMPLETION_RULE,
      { total: 1, completed: 1 },
      [quiz({ required: false })],
      [],
    );
    expect(result.completed).toBe(true);
  });

  describe('a course with no lessons (quiz-only / assignment-only)', () => {
    const none = { total: 0, completed: 0 };

    it('with nothing marked required, every published quiz must be passed', () => {
      const quizzes = [
        quiz({ quizId: 'q1', required: false, passed: true, effectiveScore: 90 }),
        quiz({ quizId: 'q2', required: false }),
      ];
      const open = evaluateCompletion(DEFAULT_COMPLETION_RULE, none, quizzes, []);
      expect(open.completed).toBe(false);
      expect(open.missing).toEqual([
        { kind: 'quiz_not_passed', id: 'q2', title: 'Quiz 1.2', detail: null },
      ]);
      const done = evaluateCompletion(
        DEFAULT_COMPLETION_RULE,
        none,
        [
          quizzes[0],
          quiz({ quizId: 'q2', required: false, passed: true, effectiveScore: 70 }),
        ],
        [],
      );
      expect(done.completed).toBe(true);
      expect(done.overallScore).toBe(80);
    });

    it('with nothing marked required, every published assignment must be graded', () => {
      const submitted = evaluateCompletion(
        DEFAULT_COMPLETION_RULE,
        none,
        [],
        [assignment({ required: false, submitted: true })],
      );
      expect(submitted.completed).toBe(false);
      expect(submitted.missing[0].kind).toBe('assignment_not_graded');
      expect(
        evaluateCompletion(
          DEFAULT_COMPLETION_RULE,
          none,
          [],
          [assignment({ required: false, submitted: true, graded: true, score: 60 })],
        ).completed,
      ).toBe(true);
    });

    it('once anything is marked required, only the marked items count', () => {
      const result = evaluateCompletion(
        DEFAULT_COMPLETION_RULE,
        none,
        [
          quiz({ quizId: 'q1', required: true, passed: true }),
          quiz({ quizId: 'q2', required: false }),
        ],
        [],
      );
      expect(result.completed).toBe(true);
    });

    it("respects the rule's own switch: requiredQuizzes off leaves quizzes out", () => {
      const result = evaluateCompletion(
        { ...DEFAULT_COMPLETION_RULE, requiredQuizzes: false },
        none,
        [quiz({ required: false, passed: true })],
        [],
      );
      // Nothing left that the rule counts: an empty course is never complete.
      expect(result.completed).toBe(false);
    });

    it('a course with lessons keeps optional quizzes optional', () => {
      expect(
        evaluateCompletion(
          DEFAULT_COMPLETION_RULE,
          { total: 2, completed: 2 },
          [quiz({ required: false })],
          [],
        ).completed,
      ).toBe(true);
    });
  });

  it('a required assignment must be graded; the overall score averages required items', () => {
    const notSubmitted = evaluateCompletion(
      DEFAULT_COMPLETION_RULE,
      { total: 1, completed: 1 },
      [],
      [assignment()],
    );
    expect(notSubmitted.missing[0].kind).toBe('assignment_not_submitted');
    const submitted = evaluateCompletion(
      DEFAULT_COMPLETION_RULE,
      { total: 1, completed: 1 },
      [],
      [assignment({ submitted: true })],
    );
    expect(submitted.missing[0].kind).toBe('assignment_not_graded');
    const graded = evaluateCompletion(
      DEFAULT_COMPLETION_RULE,
      { total: 1, completed: 1 },
      [quiz({ passed: true, effectiveScore: 90 })],
      [assignment({ submitted: true, graded: true, score: 70 })],
    );
    expect(graded.completed).toBe(true);
    expect(graded.overallScore).toBe(80);
  });

  it('enforces a minimum overall score', () => {
    const rule = { ...DEFAULT_COMPLETION_RULE, minOverallScore: 85 };
    const low = evaluateCompletion(
      rule,
      { total: 1, completed: 1 },
      [quiz({ passed: true, effectiveScore: 80 })],
      [],
    );
    expect(low.completed).toBe(false);
    expect(low.missing[0]).toMatchObject({ kind: 'min_overall_score', detail: 5 });
    const ok = evaluateCompletion(
      rule,
      { total: 1, completed: 1 },
      [quiz({ passed: true, effectiveScore: 90 })],
      [],
    );
    expect(ok.completed).toBe(true);
  });

  it('a lesson count rule needs only that many lessons', () => {
    const rule = { ...DEFAULT_COMPLETION_RULE, lessons: 2 as const };
    expect(evaluateCompletion(rule, { total: 5, completed: 2 }, [], []).completed).toBe(
      true,
    );
  });
});
