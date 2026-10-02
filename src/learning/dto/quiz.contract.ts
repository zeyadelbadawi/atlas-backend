/**
 * `Quiz`/`QuizQuestion`/`QuizQuestionOption` response contracts — match
 * `quiz.types.ts` field-for-field.
 *
 * Security-critical, non-negotiable (master plan §5.4/§9/§16, §18's
 * mandatory scenario 7): `QuizQuestionOptionResponse` structurally has no
 * `isCorrect` field — `toQuizQuestionOptionResponse` never reads
 * `option.isCorrect` at all, so there is no code path by which it could
 * leak into a serialized response, not even by future accident. Scoring
 * (`QuizzesService.submitAttempt`) reads `isCorrect` directly from the
 * Prisma row instead, never through this DTO.
 */
import type {
  Quiz as PrismaQuiz,
  QuizQuestion as PrismaQuizQuestion,
  QuizQuestionOption as PrismaQuizQuestionOption,
} from '@prisma/client';

export interface QuizQuestionOptionResponse {
  readonly id: string;
  readonly label: string;
}

export interface QuizQuestionResponse {
  readonly id: string;
  readonly quizId: string;
  readonly prompt: string;
  readonly type: PrismaQuizQuestion['type'];
  readonly options?: readonly QuizQuestionOptionResponse[];
  readonly order: number;
  readonly points: number;
}

/**
 * P64 Phase 3 — the settings a learner may know BEFORE starting (time
 * limit, window, attempts, integrity disclosure). Never the answers.
 */
export interface QuizLearnerSettingsResponse {
  readonly mode: PrismaQuiz['mode'];
  readonly timeLimitSeconds: number | null;
  readonly availableFrom: string | null;
  readonly availableUntil: string | null;
  readonly dueAt: string | null;
  readonly latePolicy: PrismaQuiz['latePolicy'];
  readonly gradingPolicy: PrismaQuiz['gradingPolicy'];
  readonly layout: PrismaQuiz['layout'];
  readonly questionsPerAttempt: number | null;
  readonly showScore: PrismaQuiz['showScore'];
  readonly showAnswers: PrismaQuiz['showAnswers'];
  readonly integrityMode: PrismaQuiz['integrityMode'];
  readonly maxViolations: number;
  readonly requireFullscreen: boolean;
  readonly requiredToProgress: boolean;
  readonly requiredForCompletion: boolean;
  readonly hideTimer: boolean;
}

export interface QuizResponse {
  readonly id: string;
  readonly courseId: string;
  readonly sectionId?: string;
  readonly title: string;
  readonly description?: string;
  readonly status: PrismaQuiz['status'];
  readonly questionCount: number;
  readonly passingScore?: number;
  readonly maxAttempts?: number;
  /**
   * The caller's OWN effective attempt allowance, override included. This
   * is the single authoritative figure the learner UI must use for
   * "attempts left" — it is `maxAttempts + the student's extraAttempts
   * override`, or `null` when attempts are unlimited (`maxAttempts` null).
   * Undefined only on the list endpoints, which are not per-student.
   * Same source of truth as the engine's `canStartAttempt`.
   */
  readonly attemptsAllowed?: number | null;
  /** The caller's own `extraAttempts` override for this quiz (0 when none). */
  readonly extraAttempts?: number;
  readonly settings: QuizLearnerSettingsResponse;
  readonly questions?: readonly QuizQuestionResponse[];
}

export function toQuizLearnerSettingsResponse(
  quiz: PrismaQuiz,
): QuizLearnerSettingsResponse {
  return {
    mode: quiz.mode,
    timeLimitSeconds: quiz.timeLimitSeconds,
    availableFrom: quiz.availableFrom?.toISOString() ?? null,
    availableUntil: quiz.availableUntil?.toISOString() ?? null,
    dueAt: quiz.dueAt?.toISOString() ?? null,
    latePolicy: quiz.latePolicy,
    gradingPolicy: quiz.gradingPolicy,
    layout: quiz.layout,
    questionsPerAttempt: quiz.questionsPerAttempt,
    showScore: quiz.showScore,
    showAnswers: quiz.showAnswers,
    integrityMode: quiz.integrityMode,
    maxViolations: quiz.maxViolations,
    // Same rule as the attempt snapshot: no full screen without integrity.
    requireFullscreen: quiz.integrityMode !== 'off' && quiz.requireFullscreen,
    requiredToProgress: quiz.requiredToProgress,
    requiredForCompletion: quiz.requiredForCompletion,
    hideTimer: quiz.hideTimer,
  };
}

export function toQuizQuestionOptionResponse(
  option: PrismaQuizQuestionOption,
): QuizQuestionOptionResponse {
  return { id: option.id, label: option.label };
}

export function toQuizQuestionResponse(
  question: PrismaQuizQuestion & { options?: PrismaQuizQuestionOption[] },
): QuizQuestionResponse {
  return {
    id: question.id,
    quizId: question.quizId,
    prompt: question.prompt,
    type: question.type,
    options: question.options?.map(toQuizQuestionOptionResponse),
    order: question.order,
    points: question.points,
  };
}

export function toQuizResponse(
  quiz: PrismaQuiz & {
    questions?: (PrismaQuizQuestion & { options?: PrismaQuizQuestionOption[] })[];
  },
  questionCount: number,
  perStudent?: {
    readonly extraAttempts: number;
    readonly attemptsAllowed: number | null;
  },
): QuizResponse {
  return {
    id: quiz.id,
    courseId: quiz.courseId,
    sectionId: quiz.sectionId ?? undefined,
    title: quiz.title,
    description: quiz.description ?? undefined,
    status: quiz.status,
    questionCount,
    passingScore: quiz.passingScore ?? undefined,
    maxAttempts: quiz.maxAttempts ?? undefined,
    ...(perStudent
      ? {
          attemptsAllowed: perStudent.attemptsAllowed,
          extraAttempts: perStudent.extraAttempts,
        }
      : {}),
    settings: toQuizLearnerSettingsResponse(quiz),
    questions: quiz.questions?.map(toQuizQuestionResponse),
  };
}
