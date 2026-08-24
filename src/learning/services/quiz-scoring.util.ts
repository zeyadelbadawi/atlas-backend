/**
 * Pure quiz-scoring functions — extracted out of `QuizzesService` so they
 * can be unit-tested exhaustively without a database, matching this
 * codebase's own precedent (`entitlement.service.spec.ts`, P4) for
 * pure, security/correctness-critical business logic.
 *
 * Binary per-question correctness only — the selected option set must
 * exactly match the set of options flagged `isCorrect`, no partial credit
 * (no such concept exists anywhere in the frontend contract).
 */

export interface ScorableOption {
  readonly id: string;
  readonly isCorrect: boolean;
}

export interface ScorableQuestion {
  readonly id: string;
  readonly options: readonly ScorableOption[];
}

export interface SubmittedAnswer {
  readonly questionId: string;
  readonly selectedOptionIds: readonly string[];
}

/** Every question must have exactly one answer entry — no missing question, no foreign/duplicate `questionId`. Mirrors `CourseCurriculumService.assertExactPermutation`'s identical "exact set match" discipline (P5), re-enforcing the frontend's own `buildQuizAttemptSchema` requirement server-side. */
export function isExactQuestionCoverage(
  questions: readonly ScorableQuestion[],
  answers: readonly SubmittedAnswer[],
): boolean {
  const questionIds = new Set(questions.map((q) => q.id));
  const answeredIds = answers.map((a) => a.questionId);
  const answeredSet = new Set(answeredIds);

  return (
    answeredIds.length === answeredSet.size &&
    questionIds.size === answeredSet.size &&
    [...questionIds].every((id) => answeredSet.has(id))
  );
}

export function scoreQuizAttempt(
  questions: readonly ScorableQuestion[],
  answers: readonly SubmittedAnswer[],
): { score: number; correctCount: number } {
  const answerByQuestion = new Map(answers.map((a) => [a.questionId, a]));

  let correctCount = 0;
  for (const question of questions) {
    const correctOptionIds = new Set(
      question.options.filter((o) => o.isCorrect).map((o) => o.id),
    );
    const selected = new Set(answerByQuestion.get(question.id)?.selectedOptionIds ?? []);
    const isCorrect =
      selected.size === correctOptionIds.size &&
      [...correctOptionIds].every((id) => selected.has(id));
    if (isCorrect) correctCount += 1;
  }

  const score = questions.length > 0 ? (correctCount / questions.length) * 100 : 0;
  return { score, correctCount };
}

/** `null` means no threshold — every submitted attempt passes. */
export function isAttemptPassing(score: number, passingScore: number | null): boolean {
  return passingScore === null || score >= passingScore;
}

/** `null` `maxAttempts` means unlimited. */
export function canStartAnotherAttempt(
  existingAttemptCount: number,
  maxAttempts: number | null,
): boolean {
  return maxAttempts === null || existingAttemptCount < maxAttempts;
}
