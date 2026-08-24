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
  readonly questions?: readonly QuizQuestionResponse[];
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
  };
}

export function toQuizResponse(
  quiz: PrismaQuiz & {
    questions?: (PrismaQuizQuestion & { options?: PrismaQuizQuestionOption[] })[];
  },
  questionCount: number,
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
    questions: quiz.questions?.map(toQuizQuestionResponse),
  };
}
