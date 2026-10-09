/**
 * P64 Phase 3 — what a learner sees during and after an attempt.
 *
 * `QuizAttemptSessionResponse` is the resume payload: the attempt's own
 * question paper (ordered, options ordered, NEVER `isCorrect`), the saved
 * answers, the server clock and the deadline. Correctness, explanations
 * and per-question review live only in `QuizAttemptResultsResponse`, and
 * only when the disclosure policy allows — the projection functions here
 * are the structural guarantee, not a "don't render it" convention.
 */
import type {
  QuizAttempt as PrismaQuizAttempt,
  QuizAttemptStatus,
  QuizIntegrityMode,
  QuizLayout,
  QuizMode,
  QuizQuestionType,
} from '@prisma/client';
import type {
  AttemptAnswer,
  Disclosure,
  EngineQuestion,
  QuestionScore,
  QuizSettingsSnapshot,
} from '../services/quiz-engine.util';

export interface SessionOptionResponse {
  readonly id: string;
  readonly label: string;
}

export interface SessionQuestionResponse {
  readonly id: string;
  readonly type: QuizQuestionType;
  readonly prompt: string;
  readonly points: number;
  readonly options: readonly SessionOptionResponse[];
}

export interface AttemptAnswerResponse {
  readonly questionId: string;
  readonly selectedOptionIds?: readonly string[];
  readonly text?: string;
}

export interface AttemptSettingsResponse {
  readonly mode: QuizMode;
  readonly layout: QuizLayout;
  readonly hideTimer: boolean;
  readonly integrityMode: QuizIntegrityMode;
  readonly maxViolations: number;
  readonly requireFullscreen: boolean;
  readonly timeLimitSeconds: number | null;
  readonly timeMultiplier: number;
  readonly engineV2: boolean;
}

export interface QuizAttemptSessionResponse {
  readonly attemptId: string;
  readonly quizId: string;
  readonly status: QuizAttemptStatus;
  readonly attemptNumber: number;
  readonly startedAt: string;
  readonly deadlineAt: string | null;
  readonly serverNow: string;
  readonly remainingSeconds: number | null;
  readonly revision: number;
  readonly lastSavedAt: string | null;
  readonly violationCount: number;
  readonly settings: AttemptSettingsResponse;
  readonly questions: readonly SessionQuestionResponse[];
  readonly answers: readonly AttemptAnswerResponse[];
  readonly attemptsUsed: number;
  readonly attemptsAllowed: number | null;
}

export interface SaveAnswersResponse {
  readonly attemptId: string;
  readonly revision: number;
  readonly applied: boolean;
  readonly savedAt: string | null;
  readonly serverNow: string;
  readonly deadlineAt: string | null;
  /**
   * Only when `applied` is false: the learner's own answers as the server
   * holds them at `revision` (no correctness, nothing a session read does
   * not already return). Lets the client merge its unsaved edits onto the
   * newer server copy and retry at `revision + 1` instead of silently
   * dropping them — the stale-revision case is two tabs, or a tab that
   * reloaded while a save was in flight. Optional: older clients ignore it.
   */
  readonly answers?: readonly AttemptAnswerResponse[];
}

export interface RecordEventsResponse {
  readonly attemptId: string;
  readonly recorded: number;
  readonly violationCount: number;
  readonly maxViolations: number;
  readonly action: 'none' | 'warn' | 'auto_submit';
  readonly status: QuizAttemptStatus;
}

export interface ResultQuestionResponse {
  readonly questionId: string;
  readonly prompt: string;
  readonly type: QuizQuestionType;
  readonly points: number;
  readonly answered: boolean;
  /** Disclosed per policy; absent otherwise. */
  readonly correct?: boolean | null;
  readonly pointsAwarded?: number;
  readonly yourAnswer: AttemptAnswerResponse | null;
  /** Correct option ids / accepted answers — ONLY when the policy allows. */
  readonly correctOptionIds?: readonly string[];
  readonly acceptedAnswers?: readonly string[];
  readonly explanation?: string;
  readonly relatedLessonId?: string;
  readonly needsManualGrading: boolean;
}

export interface QuizAttemptResultsResponse {
  readonly attemptId: string;
  readonly quizId: string;
  readonly status: QuizAttemptStatus;
  readonly attemptNumber: number;
  readonly submittedAt: string | null;
  readonly autoSubmitted: boolean;
  readonly autoSubmittedReason: string | null;
  readonly isLate: boolean;
  readonly gradingStatus: PrismaQuizAttempt['gradingStatus'];
  readonly disclosure: Disclosure;
  /** Present only when `disclosure.score`. */
  readonly score?: number | null;
  readonly passed?: boolean | null;
  readonly pointsEarned?: number;
  readonly pointsTotal?: number;
  readonly passingScore: number | null;
  readonly questions: readonly ResultQuestionResponse[];
  readonly canRetry: boolean;
  readonly attemptsUsed: number;
  readonly attemptsAllowed: number | null;
  /** The quiz-level effective result (grading policy) when disclosed. */
  readonly effectiveScore?: number | null;
  readonly effectivePassed?: boolean;
}

export function toSessionQuestion(
  question: EngineQuestion,
  optionOrder: readonly string[] | undefined,
): SessionQuestionResponse {
  const byId = new Map(question.options.map((option) => [option.id, option]));
  const order = optionOrder ?? question.options.map((option) => option.id);
  return {
    id: question.id,
    type: question.type,
    prompt: question.prompt,
    points: question.points,
    // Structural: only `id` and `label` are ever copied.
    options: order
      .map((id) => byId.get(id))
      .filter((option): option is NonNullable<typeof option> => Boolean(option))
      .map((option) => ({ id: option.id, label: option.label })),
  };
}

export function toAnswerResponse(answer: AttemptAnswer): AttemptAnswerResponse {
  return {
    questionId: answer.questionId,
    ...(answer.selectedOptionIds
      ? { selectedOptionIds: [...answer.selectedOptionIds] }
      : {}),
    ...(answer.text !== undefined ? { text: answer.text } : {}),
  };
}

export function toResultQuestion(
  question: EngineQuestion,
  answer: AttemptAnswer | undefined,
  score: QuestionScore | undefined,
  disclosure: Disclosure,
): ResultQuestionResponse {
  const base: ResultQuestionResponse = {
    questionId: question.id,
    prompt: question.prompt,
    type: question.type,
    points: question.points,
    answered: score?.answered ?? Boolean(answer),
    yourAnswer: answer ? toAnswerResponse(answer) : null,
    needsManualGrading: score?.needsManualGrading ?? false,
  };
  const withScore: ResultQuestionResponse = disclosure.score
    ? {
        ...base,
        correct: score?.correct ?? null,
        pointsAwarded: score?.pointsAwarded ?? 0,
      }
    : base;
  if (!disclosure.answers) return withScore;
  return {
    ...withScore,
    correctOptionIds: question.options
      .filter((option) => option.isCorrect)
      .map((option) => option.id),
    ...(question.acceptedAnswers
      ? { acceptedAnswers: [...question.acceptedAnswers] }
      : {}),
    ...(disclosure.explanations && question.explanation
      ? { explanation: question.explanation }
      : {}),
    ...(question.relatedLessonId ? { relatedLessonId: question.relatedLessonId } : {}),
  };
}

export function settingsToResponse(
  snapshot: QuizSettingsSnapshot,
): AttemptSettingsResponse {
  return {
    mode: snapshot.mode,
    layout: snapshot.layout,
    hideTimer: snapshot.hideTimer,
    integrityMode: snapshot.integrityMode,
    maxViolations: snapshot.maxViolations,
    requireFullscreen: snapshot.requireFullscreen,
    timeLimitSeconds: snapshot.timeLimitSeconds,
    timeMultiplier: snapshot.timeMultiplier,
    engineV2: snapshot.engineV2,
  };
}
