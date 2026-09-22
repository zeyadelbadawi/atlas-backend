import {
  aggregateResult,
  buildAttemptPlan,
  canStartAttempt,
  computeDeadline,
  decideIntegrity,
  isPastGrace,
  mulberry32,
  normalizeShortAnswer,
  resolveDisclosure,
  resolveWindow,
  scoreAttempt,
  validateAnswers,
  type EngineQuestion,
  type IncomingEvent,
  INTEGRITY_DEBOUNCE_MS,
  INTEGRITY_WARM_UP_MS,
  QUIZ_SUBMIT_GRACE_SECONDS,
} from './quiz-engine.util';

const T0 = new Date('2026-09-22T10:00:00.000Z');
const sec = (n: number) => new Date(T0.getTime() + n * 1000);

function q(
  id: string,
  type: EngineQuestion['type'],
  correct: readonly string[] = [],
  extra: Partial<EngineQuestion> = {},
): EngineQuestion {
  const options =
    type === 'short_answer' || type === 'essay'
      ? []
      : ['a', 'b', 'c'].map((suffix) => ({
          id: `${id}-${suffix}`,
          label: suffix,
          isCorrect: correct.includes(`${id}-${suffix}`),
        }));
  return {
    id,
    type,
    prompt: id,
    points: 1,
    order: Number(id.replace(/\D/g, '')) || 0,
    explanation: null,
    relatedLessonId: null,
    acceptedAnswers: null,
    options,
    ...extra,
  };
}

describe('quiz engine — deadline and grace (fake clock)', () => {
  it('derives the deadline from the server start, the limit and the multiplier', () => {
    const deadline = computeDeadline({
      startedAt: T0,
      timeLimitSeconds: 600,
      timeMultiplier: 1.5,
      availableUntil: null,
    });
    expect(deadline).toEqual(sec(900));
  });

  it('caps the deadline at the window close', () => {
    const deadline = computeDeadline({
      startedAt: T0,
      timeLimitSeconds: 600,
      timeMultiplier: 1,
      availableUntil: sec(120),
    });
    expect(deadline).toEqual(sec(120));
  });

  it('has no deadline without a limit or a window', () => {
    expect(
      computeDeadline({
        startedAt: T0,
        timeLimitSeconds: null,
        timeMultiplier: 1,
        availableUntil: null,
      }),
    ).toBeNull();
  });

  it('accepts saves inside the grace window and rejects after it', () => {
    const deadline = sec(600);
    expect(isPastGrace(deadline, sec(600 + QUIZ_SUBMIT_GRACE_SECONDS))).toBe(false);
    expect(isPastGrace(deadline, sec(600 + QUIZ_SUBMIT_GRACE_SECONDS + 1))).toBe(true);
    expect(isPastGrace(null, sec(999999))).toBe(false);
  });

  it('resolves the start window with the late policy', () => {
    const base = {
      now: sec(0),
      availableFrom: null,
      availableUntil: null,
      dueAt: null,
      latePolicy: 'block' as const,
    };
    expect(resolveWindow(base)).toBe('open');
    expect(resolveWindow({ ...base, availableFrom: sec(10) })).toBe('not_yet_open');
    expect(resolveWindow({ ...base, availableUntil: sec(-1) })).toBe('closed');
    expect(resolveWindow({ ...base, dueAt: sec(-1) })).toBe('late_blocked');
    expect(resolveWindow({ ...base, dueAt: sec(-1), latePolicy: 'accept_flagged' })).toBe(
      'late_allowed',
    );
  });

  it('counts extra attempts on top of the cap', () => {
    expect(canStartAttempt(2, 2, 0)).toBe(false);
    expect(canStartAttempt(2, 2, 1)).toBe(true);
    expect(canStartAttempt(50, null, 0)).toBe(true);
  });
});

describe('quiz engine — seeded ordering', () => {
  const questions = [
    q('q1', 'single_choice'),
    q('q2', 'single_choice'),
    q('q3', 'single_choice'),
    q('q4', 'single_choice'),
  ];

  it('is deterministic for a seed and differs across seeds', () => {
    const a = buildAttemptPlan(
      questions,
      { shuffleQuestions: true, shuffleOptions: true, questionsPerAttempt: null },
      42,
    );
    const b = buildAttemptPlan(
      questions,
      { shuffleQuestions: true, shuffleOptions: true, questionsPerAttempt: null },
      42,
    );
    const c = buildAttemptPlan(
      questions,
      { shuffleQuestions: true, shuffleOptions: true, questionsPerAttempt: null },
      43,
    );
    expect(a).toEqual(b);
    expect([...a.questionIds].sort()).toEqual(['q1', 'q2', 'q3', 'q4']);
    expect(
      a.questionIds.join() === c.questionIds.join() &&
        JSON.stringify(a.optionOrder) === JSON.stringify(c.optionOrder),
    ).toBe(false);
  });

  it('keeps authoring order and samples the first N when not shuffling', () => {
    const plan = buildAttemptPlan(
      questions,
      { shuffleQuestions: false, shuffleOptions: false, questionsPerAttempt: 2 },
      1,
    );
    expect(plan.questionIds).toEqual(['q1', 'q2']);
    expect(plan.optionOrder.q1).toEqual(['q1-a', 'q1-b', 'q1-c']);
  });

  it('mulberry32 is a stable generator', () => {
    const r = mulberry32(7);
    const first = [r(), r(), r()];
    const r2 = mulberry32(7);
    expect([r2(), r2(), r2()]).toEqual(first);
  });
});

describe('quiz engine — answer validation and scoring', () => {
  const questions = [
    q('q1', 'single_choice', ['q1-a'], { points: 2 }),
    q('q2', 'multiple_choice', ['q2-a', 'q2-b'], { points: 3 }),
    q('q3', 'short_answer', [], { acceptedAnswers: ['Hola', 'hola!'] }),
    q('q4', 'essay', [], { points: 4 }),
  ];

  it('rejects foreign options, duplicates, wrong shapes and over-long text', () => {
    expect(
      validateAnswers(questions, [{ questionId: 'zzz', selectedOptionIds: [] }]),
    ).toBe('unknownQuestion');
    expect(
      validateAnswers(questions, [{ questionId: 'q1', selectedOptionIds: ['q2-a'] }]),
    ).toBe('invalidOption');
    expect(
      validateAnswers(questions, [
        { questionId: 'q1', selectedOptionIds: ['q1-a', 'q1-b'] },
      ]),
    ).toBe('invalidOption');
    expect(
      validateAnswers(questions, [
        { questionId: 'q1', selectedOptionIds: ['q1-a'] },
        { questionId: 'q1', selectedOptionIds: ['q1-b'] },
      ]),
    ).toBe('duplicateQuestion');
    expect(
      validateAnswers(questions, [{ questionId: 'q3', selectedOptionIds: ['q1-a'] }]),
    ).toBe('wrongAnswerShape');
    expect(validateAnswers(questions, [{ questionId: 'q1', text: 'hi' }])).toBe(
      'wrongAnswerShape',
    );
    expect(
      validateAnswers(questions, [{ questionId: 'q3', text: 'x'.repeat(2001) }]),
    ).toBe('textTooLong');
    expect(validateAnswers(questions, [{ questionId: 'q3', text: 'hola' }])).toBeNull();
    expect(validateAnswers(questions, [])).toBeNull();
  });

  it('scores by points with exact-set choice matching, normalised short answers and pending essays', () => {
    const result = scoreAttempt(
      questions,
      [
        { questionId: 'q1', selectedOptionIds: ['q1-a'] },
        { questionId: 'q2', selectedOptionIds: ['q2-a'] },
        { questionId: 'q3', text: '  HOLA ' },
        { questionId: 'q4', text: 'An essay.' },
      ],
      null,
    );
    expect(result.pointsTotal).toBe(10);
    expect(result.pendingManual).toBe(true);
    expect(result.score).toBeNull();
    expect(result.perQuestion.map((p) => p.correct)).toEqual([true, false, true, null]);
  });

  it('finalises once the essay is graded, clamping manual points to the maximum', () => {
    const result = scoreAttempt(
      questions,
      [
        { questionId: 'q1', selectedOptionIds: ['q1-a'] },
        { questionId: 'q4', text: 'An essay.' },
      ],
      { q4: 99 },
    );
    expect(result.pendingManual).toBe(false);
    expect(result.pointsEarned).toBe(6);
    expect(result.score).toBe(60);
    // Unanswered questions are incorrect, never "skipped".
    expect(result.perQuestion.find((p) => p.questionId === 'q2')?.correct).toBe(false);
  });

  it('treats an unanswered essay as incorrect rather than pending', () => {
    const result = scoreAttempt(questions, [], null);
    expect(result.pendingManual).toBe(false);
    expect(result.score).toBe(0);
  });

  it('normalises short answers', () => {
    expect(normalizeShortAnswer('  Héllo   World ')).toBe('héllo world');
  });
});

describe('quiz engine — grading policy', () => {
  const attempts = [
    {
      id: 'a1',
      attemptNumber: 1,
      score: 40,
      passed: false,
      submittedAt: sec(10),
      pendingGrading: false,
    },
    {
      id: 'a2',
      attemptNumber: 2,
      score: 90,
      passed: true,
      submittedAt: sec(20),
      pendingGrading: false,
    },
    {
      id: 'a3',
      attemptNumber: 3,
      score: 60,
      passed: true,
      submittedAt: sec(30),
      pendingGrading: false,
    },
  ];

  it('picks highest / latest / first / average', () => {
    expect(aggregateResult('highest', attempts, 50)).toMatchObject({
      effectiveScore: 90,
      effectiveAttemptId: 'a2',
      passed: true,
    });
    expect(aggregateResult('latest', attempts, 50)).toMatchObject({
      effectiveScore: 60,
      effectiveAttemptId: 'a3',
      passed: true,
    });
    expect(aggregateResult('first', attempts, 50)).toMatchObject({
      effectiveScore: 40,
      effectiveAttemptId: 'a1',
      passed: false,
    });
    expect(aggregateResult('average', attempts, 50)).toMatchObject({
      effectiveScore: 63.33,
      effectiveAttemptId: null,
      passed: true,
    });
  });

  it('ignores pending attempts for the score but reports them', () => {
    const withPending = [
      ...attempts,
      {
        id: 'a4',
        attemptNumber: 4,
        score: null,
        passed: null,
        submittedAt: sec(40),
        pendingGrading: true,
      },
    ];
    const result = aggregateResult('latest', withPending, 50);
    expect(result).toMatchObject({
      effectiveScore: 60,
      pendingGrading: true,
      attemptsCount: 4,
    });
  });

  it('has no result without a scored attempt', () => {
    expect(aggregateResult('highest', [], 50)).toMatchObject({
      effectiveScore: null,
      passed: false,
      attemptsCount: 0,
    });
  });
});

describe('quiz engine — disclosure matrix', () => {
  const base = {
    showScore: 'immediately' as const,
    showAnswers: 'never' as const,
    showExplanations: true,
    now: sec(0),
    dueAt: null,
    availableUntil: null,
    attemptsUsed: 1,
    maxAttempts: 2,
    attemptFinalized: true,
  };

  it('never discloses anything before the attempt is finalised', () => {
    expect(
      resolveDisclosure({ ...base, showAnswers: 'immediately', attemptFinalized: false }),
    ).toEqual({
      score: false,
      answers: false,
      explanations: false,
    });
  });

  it('withholds answers under never and shows them immediately when allowed', () => {
    expect(resolveDisclosure(base).answers).toBe(false);
    expect(resolveDisclosure({ ...base, showAnswers: 'immediately' })).toEqual({
      score: true,
      answers: true,
      explanations: true,
    });
  });

  it('waits for the due date, then for exhausted attempts', () => {
    expect(
      resolveDisclosure({ ...base, showAnswers: 'after_due', dueAt: sec(60) }).answers,
    ).toBe(false);
    expect(
      resolveDisclosure({ ...base, showAnswers: 'after_due', dueAt: sec(-60) }).answers,
    ).toBe(true);
    expect(
      resolveDisclosure({ ...base, showAnswers: 'after_attempts_exhausted' }).answers,
    ).toBe(false);
    expect(
      resolveDisclosure({
        ...base,
        showAnswers: 'after_attempts_exhausted',
        attemptsUsed: 2,
      }).answers,
    ).toBe(true);
    // Unlimited attempts can never be exhausted.
    expect(
      resolveDisclosure({
        ...base,
        showAnswers: 'after_attempts_exhausted',
        maxAttempts: null,
        attemptsUsed: 9,
      }).answers,
    ).toBe(false);
  });

  it('explanations follow answers', () => {
    expect(
      resolveDisclosure({ ...base, showAnswers: 'immediately', showExplanations: false })
        .explanations,
    ).toBe(false);
  });
});

describe('quiz engine — integrity escalation', () => {
  const started = sec(0);
  const afterWarmUp = new Date(started.getTime() + INTEGRITY_WARM_UP_MS + 1000);
  const ev = (type: IncomingEvent['type']): IncomingEvent => ({ type, clientAt: null });

  function decide(
    events: IncomingEvent[],
    overrides: Partial<Parameters<typeof decideIntegrity>[0]> = {},
  ) {
    return decideIntegrity({
      mode: 'warn',
      maxViolations: 3,
      violationCount: 0,
      startedAt: started,
      now: afterWarmUp,
      lastCountedAt: new Map(),
      lastHiddenAt: null,
      events,
      ...overrides,
    });
  }

  it('records nothing as a violation when integrity is off', () => {
    const d = decide([ev('blur'), ev('copy')], { mode: 'off' });
    expect(d.counted).toEqual([false, false]);
    expect(d.action).toBe('none');
    expect(d.flagged).toBe(false);
  });

  it('ignores events during the warm-up', () => {
    const d = decide([ev('blur')], { now: new Date(started.getTime() + 1000) });
    expect(d.counted).toEqual([false]);
    expect(d.violationCount).toBe(0);
  });

  it('debounces repeated events of one type inside the window', () => {
    const d = decide([ev('blur')], {
      lastCountedAt: new Map([
        ['blur', new Date(afterWarmUp.getTime() - INTEGRITY_DEBOUNCE_MS + 100)],
      ]),
    });
    expect(d.counted).toEqual([false]);
  });

  it('does not count a sub-second visibility flicker', () => {
    const d = decide([ev('visibility_hidden'), ev('visibility_visible')]);
    expect(d.counted).toEqual([false, false]);
    expect(d.violationCount).toBe(0);
  });

  it('warns in warn mode and only warns, never auto-submits', () => {
    const d = decide([ev('copy')], { violationCount: 10 });
    expect(d.action).toBe('warn');
    expect(d.flagged).toBe(true);
  });

  it('monitor mode records and flags without warning', () => {
    const d = decide([ev('paste')], { mode: 'monitor' });
    expect(d.counted).toEqual([true]);
    expect(d.action).toBe('none');
    expect(d.flagged).toBe(true);
  });

  it('strict mode auto-submits exactly at the threshold', () => {
    expect(decide([ev('blur')], { mode: 'strict', violationCount: 1 }).action).toBe(
      'warn',
    );
    expect(decide([ev('blur')], { mode: 'strict', violationCount: 2 }).action).toBe(
      'auto_submit',
    );
  });

  it('heartbeats never count', () => {
    const d = decide([ev('heartbeat')], { mode: 'strict', violationCount: 2 });
    expect(d.counted).toEqual([false]);
    expect(d.action).toBe('none');
  });
});
