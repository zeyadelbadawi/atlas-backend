import {
  canStartAnotherAttempt,
  isAttemptPassing,
  isExactQuestionCoverage,
  scoreQuizAttempt,
  type ScorableQuestion,
} from './quiz-scoring.util';

const singleChoice: ScorableQuestion = {
  id: 'q1',
  options: [
    { id: 'q1-a', isCorrect: true },
    { id: 'q1-b', isCorrect: false },
  ],
};

const multipleChoice: ScorableQuestion = {
  id: 'q2',
  options: [
    { id: 'q2-a', isCorrect: true },
    { id: 'q2-b', isCorrect: true },
    { id: 'q2-c', isCorrect: false },
  ],
};

const trueFalse: ScorableQuestion = {
  id: 'q3',
  options: [
    { id: 'q3-true', isCorrect: false },
    { id: 'q3-false', isCorrect: true },
  ],
};

describe('isExactQuestionCoverage', () => {
  const questions = [singleChoice, multipleChoice, trueFalse];

  it('accepts exactly one answer per question, no more, no fewer', () => {
    const answers = [
      { questionId: 'q1', selectedOptionIds: ['q1-a'] },
      { questionId: 'q2', selectedOptionIds: ['q2-a', 'q2-b'] },
      { questionId: 'q3', selectedOptionIds: ['q3-false'] },
    ];
    expect(isExactQuestionCoverage(questions, answers)).toBe(true);
  });

  it('rejects a missing question', () => {
    const answers = [
      { questionId: 'q1', selectedOptionIds: ['q1-a'] },
      { questionId: 'q2', selectedOptionIds: ['q2-a'] },
    ];
    expect(isExactQuestionCoverage(questions, answers)).toBe(false);
  });

  it('rejects an answer for a foreign/nonexistent question id', () => {
    const answers = [
      { questionId: 'q1', selectedOptionIds: ['q1-a'] },
      { questionId: 'q2', selectedOptionIds: ['q2-a'] },
      { questionId: 'q3', selectedOptionIds: ['q3-false'] },
      { questionId: 'not-a-real-question', selectedOptionIds: ['x'] },
    ];
    expect(isExactQuestionCoverage(questions, answers)).toBe(false);
  });

  it('rejects a duplicate answer for the same question', () => {
    const answers = [
      { questionId: 'q1', selectedOptionIds: ['q1-a'] },
      { questionId: 'q1', selectedOptionIds: ['q1-b'] },
      { questionId: 'q2', selectedOptionIds: ['q2-a'] },
      { questionId: 'q3', selectedOptionIds: ['q3-false'] },
    ];
    expect(isExactQuestionCoverage(questions, answers)).toBe(false);
  });

  it('accepts an empty quiz with an empty answer set', () => {
    expect(isExactQuestionCoverage([], [])).toBe(true);
  });
});

describe('scoreQuizAttempt', () => {
  const questions = [singleChoice, multipleChoice, trueFalse];

  it('scores 100 when every question is answered exactly correctly', () => {
    const answers = [
      { questionId: 'q1', selectedOptionIds: ['q1-a'] },
      { questionId: 'q2', selectedOptionIds: ['q2-a', 'q2-b'] },
      { questionId: 'q3', selectedOptionIds: ['q3-false'] },
    ];
    const result = scoreQuizAttempt(questions, answers);
    expect(result.score).toBe(100);
    expect(result.correctCount).toBe(3);
  });

  it('scores 0 when every answer is wrong', () => {
    const answers = [
      { questionId: 'q1', selectedOptionIds: ['q1-b'] },
      { questionId: 'q2', selectedOptionIds: ['q2-c'] },
      { questionId: 'q3', selectedOptionIds: ['q3-true'] },
    ];
    const result = scoreQuizAttempt(questions, answers);
    expect(result.score).toBe(0);
    expect(result.correctCount).toBe(0);
  });

  it('gives no credit for a multiple-choice question answered only partially correct (no partial credit)', () => {
    const answers = [
      { questionId: 'q1', selectedOptionIds: ['q1-a'] },
      // Only one of the two correct options selected — must not count.
      { questionId: 'q2', selectedOptionIds: ['q2-a'] },
      { questionId: 'q3', selectedOptionIds: ['q3-false'] },
    ];
    const result = scoreQuizAttempt(questions, answers);
    expect(result.correctCount).toBe(2);
    expect(result.score).toBeCloseTo((2 / 3) * 100);
  });

  it('gives no credit when a correct option is selected alongside an extra incorrect one', () => {
    const answers = [
      { questionId: 'q1', selectedOptionIds: ['q1-a', 'q1-b'] },
      { questionId: 'q2', selectedOptionIds: ['q2-a', 'q2-b'] },
      { questionId: 'q3', selectedOptionIds: ['q3-false'] },
    ];
    const result = scoreQuizAttempt(questions, answers);
    // q1 is wrong (extra option selected beyond the single correct one).
    expect(result.correctCount).toBe(2);
  });

  it('treats a question with no submitted answer as simply incorrect, not a crash', () => {
    const result = scoreQuizAttempt(questions, []);
    expect(result.score).toBe(0);
    expect(result.correctCount).toBe(0);
  });

  it('scores an empty quiz as 0, never NaN or a division-by-zero artifact', () => {
    const result = scoreQuizAttempt([], []);
    expect(result.score).toBe(0);
    expect(result.correctCount).toBe(0);
  });
});

describe('isAttemptPassing', () => {
  it('always passes when passingScore is null (no threshold)', () => {
    expect(isAttemptPassing(0, null)).toBe(true);
    expect(isAttemptPassing(100, null)).toBe(true);
  });

  it('passes when score meets the threshold exactly', () => {
    expect(isAttemptPassing(70, 70)).toBe(true);
  });

  it('passes when score exceeds the threshold', () => {
    expect(isAttemptPassing(90, 70)).toBe(true);
  });

  it('fails when score is below the threshold', () => {
    expect(isAttemptPassing(69, 70)).toBe(false);
  });
});

describe('canStartAnotherAttempt', () => {
  it('always allows another attempt when maxAttempts is null (unlimited)', () => {
    expect(canStartAnotherAttempt(0, null)).toBe(true);
    expect(canStartAnotherAttempt(1000, null)).toBe(true);
  });

  it('allows an attempt while under the limit', () => {
    expect(canStartAnotherAttempt(1, 3)).toBe(true);
  });

  it('blocks an attempt once the limit is reached', () => {
    expect(canStartAnotherAttempt(3, 3)).toBe(false);
  });

  it('blocks an attempt beyond the limit', () => {
    expect(canStartAnotherAttempt(4, 3)).toBe(false);
  });
});
