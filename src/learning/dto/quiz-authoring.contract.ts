/**
 * Quiz AUTHORING response contract (Phase 4, P24) — structurally distinct
 * from `quiz.contract.ts`'s `QuizResponse`/`QuizQuestionResponse`/
 * `QuizQuestionOptionResponse`, which must never carry `isCorrect` (see
 * that file's own header comment — the mandatory pre-submission
 * correctness-projection guarantee, master plan §5.4/§9/§16/§18 scenario
 * 7). This file is the one deliberate exception: an author who is about
 * to grade/edit their own quiz's answer key needs to see which options
 * they marked correct.
 *
 * The safety boundary is therefore NOT "this field never exists in any
 * response type" — it is "this response type is only ever returned from
 * `QuizzesService`'s authoring methods (`createQuiz`/`updateQuiz`/
 * `getQuizForAuthoring`/`getQuizzesForAuthoring`), every one of which
 * gates on `assertCanAuthorCourseContent` — never from `getQuiz`/
 * `getQuizzes` (the student-safe, enrollment-or-instructor-reachable read
 * path), which continues to use the original `quiz.contract.ts` mappers,
 * completely unmodified.
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
  readonly questions: readonly QuizQuestionAuthoringResponse[];
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
    questions: quiz.questions.map((question) => ({
      id: question.id,
      quizId: question.quizId,
      prompt: question.prompt,
      type: question.type,
      order: question.order,
      options: question.options.map((option) => ({
        id: option.id,
        label: option.label,
        isCorrect: option.isCorrect,
      })),
    })),
  };
}
