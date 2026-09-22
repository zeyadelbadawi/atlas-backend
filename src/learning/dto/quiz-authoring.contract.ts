/**
 * Authoring projection of a quiz — the ONLY response that carries
 * `isCorrect` and `acceptedAnswers`, reachable solely through
 * `assertCanAuthorCourseContent`. P64 Phase 3 adds the settings block and
 * the per-question points / explanation / related lesson.
 */
import type {
  Quiz as PrismaQuiz,
  QuizQuestion as PrismaQuizQuestion,
  QuizQuestionOption as PrismaQuizQuestionOption,
} from '@prisma/client';

export interface QuizQuestionOptionAuthoringResponse {
  readonly id: string;
  readonly label: string;
  readonly isCorrect: boolean;
}

export interface QuizQuestionAuthoringResponse {
  readonly id: string;
  readonly quizId: string;
  readonly prompt: string;
  readonly type: PrismaQuizQuestion['type'];
  readonly options: readonly QuizQuestionOptionAuthoringResponse[];
  readonly order: number;
  readonly points: number;
  readonly explanation?: string;
  readonly relatedLessonId?: string;
  readonly acceptedAnswers?: readonly string[];
}

export interface QuizSettingsResponse {
  readonly mode: PrismaQuiz['mode'];
  readonly timeLimitSeconds: number | null;
  readonly availableFrom: string | null;
  readonly availableUntil: string | null;
  readonly dueAt: string | null;
  readonly latePolicy: PrismaQuiz['latePolicy'];
  readonly gradingPolicy: PrismaQuiz['gradingPolicy'];
  readonly shuffleQuestions: boolean;
  readonly shuffleOptions: boolean;
  readonly questionsPerAttempt: number | null;
  readonly layout: PrismaQuiz['layout'];
  readonly showScore: PrismaQuiz['showScore'];
  readonly showAnswers: PrismaQuiz['showAnswers'];
  readonly showExplanations: boolean;
  readonly integrityMode: PrismaQuiz['integrityMode'];
  readonly maxViolations: number;
  readonly requireFullscreen: boolean;
  readonly requiredToProgress: boolean;
  readonly requiredForCompletion: boolean;
  readonly hideTimer: boolean;
}

export interface QuizAuthoringResponse {
  readonly id: string;
  readonly courseId: string;
  readonly sectionId?: string;
  readonly title: string;
  readonly description?: string;
  readonly status: PrismaQuiz['status'];
  readonly questionCount: number;
  readonly passingScore?: number;
  readonly maxAttempts?: number;
  readonly settings: QuizSettingsResponse;
  readonly questions: readonly QuizQuestionAuthoringResponse[];
}

export function toQuizSettingsResponse(quiz: PrismaQuiz): QuizSettingsResponse {
  return {
    mode: quiz.mode,
    timeLimitSeconds: quiz.timeLimitSeconds,
    availableFrom: quiz.availableFrom?.toISOString() ?? null,
    availableUntil: quiz.availableUntil?.toISOString() ?? null,
    dueAt: quiz.dueAt?.toISOString() ?? null,
    latePolicy: quiz.latePolicy,
    gradingPolicy: quiz.gradingPolicy,
    shuffleQuestions: quiz.shuffleQuestions,
    shuffleOptions: quiz.shuffleOptions,
    questionsPerAttempt: quiz.questionsPerAttempt,
    layout: quiz.layout,
    showScore: quiz.showScore,
    showAnswers: quiz.showAnswers,
    showExplanations: quiz.showExplanations,
    integrityMode: quiz.integrityMode,
    maxViolations: quiz.maxViolations,
    requireFullscreen: quiz.requireFullscreen,
    requiredToProgress: quiz.requiredToProgress,
    requiredForCompletion: quiz.requiredForCompletion,
    hideTimer: quiz.hideTimer,
  };
}

export function toQuizAuthoringResponse(
  quiz: PrismaQuiz & {
    questions: (PrismaQuizQuestion & { options: PrismaQuizQuestionOption[] })[];
  },
): QuizAuthoringResponse {
  return {
    id: quiz.id,
    courseId: quiz.courseId,
    sectionId: quiz.sectionId ?? undefined,
    title: quiz.title,
    description: quiz.description ?? undefined,
    status: quiz.status,
    questionCount: quiz.questions.length,
    passingScore: quiz.passingScore ?? undefined,
    maxAttempts: quiz.maxAttempts ?? undefined,
    settings: toQuizSettingsResponse(quiz),
    questions: [...quiz.questions]
      .sort((a, b) => a.order - b.order)
      .map((question) => ({
        id: question.id,
        quizId: question.quizId,
        prompt: question.prompt,
        type: question.type,
        order: question.order,
        points: question.points,
        explanation: question.explanation ?? undefined,
        relatedLessonId: question.relatedLessonId ?? undefined,
        acceptedAnswers: Array.isArray(question.acceptedAnswers)
          ? (question.acceptedAnswers as string[])
          : undefined,
        options: question.options.map((option) => ({
          id: option.id,
          label: option.label,
          isCorrect: option.isCorrect,
        })),
      })),
  };
}
