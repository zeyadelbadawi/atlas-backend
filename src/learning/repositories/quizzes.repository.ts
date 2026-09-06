/**
 * QuizzesRepository — read+write for quizzes/questions/options as of
 * Phase 4 (P24; read-only through P6-P23, see `learning.module.ts`'s doc
 * comment), read+write for `quiz_attempts` (the one student-owned,
 * mutable P6 quiz table). Every method takes a `Prisma.TransactionClient`,
 * matching every other repository in this codebase's established rule.
 */
import { Injectable } from '@nestjs/common';
import type {
  Prisma,
  Quiz,
  QuizAttempt,
  QuizQuestion,
  QuizQuestionOption,
} from '@prisma/client';

export type QuizWithQuestions = Quiz & {
  questions: (QuizQuestion & { options: QuizQuestionOption[] })[];
};

const QUESTIONS_WITH_OPTIONS_INCLUDE = {
  orderBy: { order: 'asc' as const },
  include: { options: { orderBy: { createdAt: 'asc' as const } } },
};

@Injectable()
export class QuizzesRepository {
  async findManyPublishedForCourse(
    tx: Prisma.TransactionClient,
    courseId: string,
  ): Promise<(Quiz & { _count: { questions: number } })[]> {
    return tx.quiz.findMany({
      where: { courseId, status: 'published' },
      include: { _count: { select: { questions: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Lightweight existence/ownership check — no question data — used by attempt start/list/submit, which don't need the full question set. */
  findPublishedById(
    tx: Prisma.TransactionClient,
    courseId: string,
    quizId: string,
  ): Promise<Quiz | null> {
    return tx.quiz.findFirst({ where: { id: quizId, courseId, status: 'published' } });
  }

  findPublishedByIdWithQuestions(
    tx: Prisma.TransactionClient,
    courseId: string,
    quizId: string,
  ): Promise<QuizWithQuestions | null> {
    return tx.quiz.findFirst({
      where: { id: quizId, courseId, status: 'published' },
      include: {
        questions: {
          orderBy: { order: 'asc' },
          include: { options: { orderBy: { createdAt: 'asc' } } },
        },
      },
    });
  }

  /** Same as `findPublishedByIdWithQuestions` but with no `courseId`/`status` filter — used only for scoring an already-verified attempt, never exposed to a response DTO (see `quiz.contract.ts`'s header comment on why `isCorrect` must never reach a pre-submission response). */
  findByIdWithCorrectAnswers(
    tx: Prisma.TransactionClient,
    quizId: string,
  ): Promise<QuizWithQuestions | null> {
    return tx.quiz.findUnique({
      where: { id: quizId },
      include: {
        questions: { include: { options: true } },
      },
    });
  }

  countAttemptsForStudent(
    tx: Prisma.TransactionClient,
    studentId: string,
    quizId: string,
  ): Promise<number> {
    return tx.quizAttempt.count({ where: { studentId, quizId } });
  }

  createAttempt(
    tx: Prisma.TransactionClient,
    data: Prisma.QuizAttemptCreateInput,
  ): Promise<QuizAttempt> {
    return tx.quizAttempt.create({ data });
  }

  findAttemptById(tx: Prisma.TransactionClient, id: string): Promise<QuizAttempt | null> {
    return tx.quizAttempt.findUnique({ where: { id } });
  }

  async findAttemptsForStudent(
    tx: Prisma.TransactionClient,
    studentId: string,
    quizId: string,
  ): Promise<{ items: QuizAttempt[]; totalItems: number }> {
    const where: Prisma.QuizAttemptWhereInput = { studentId, quizId };
    const [items, totalItems] = await Promise.all([
      tx.quizAttempt.findMany({ where, orderBy: { attemptNumber: 'asc' } }),
      tx.quizAttempt.count({ where }),
    ]);
    return { items, totalItems };
  }

  updateAttempt(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.QuizAttemptUpdateInput,
  ): Promise<QuizAttempt> {
    return tx.quizAttempt.update({ where: { id }, data });
  }

  // ---------------------------------------------------------------------
  // Phase 4 (P24) — authoring. Every method below is reachable only from
  // `QuizzesService`'s authoring methods, each gated by
  // `assertCanAuthorCourseContent` — never from the student-facing read
  // methods above, and never returned through `quiz.contract.ts`'s
  // mappers (see `quiz-authoring.contract.ts`'s own header comment).
  // ---------------------------------------------------------------------

  /** Every status (draft + published) — the authoring list must show a course's in-progress drafts, unlike `findManyPublishedForCourse`. */
  findManyForCourseAnyStatus(
    tx: Prisma.TransactionClient,
    courseId: string,
  ): Promise<(Quiz & { _count: { questions: number } })[]> {
    return tx.quiz.findMany({
      where: { courseId },
      include: { _count: { select: { questions: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Any status, with the full question/option set including `isCorrect` — the authoring counterpart of `findPublishedByIdWithQuestions`. */
  findAnyByIdWithQuestions(
    tx: Prisma.TransactionClient,
    courseId: string,
    quizId: string,
  ): Promise<QuizWithQuestions | null> {
    return tx.quiz.findFirst({
      where: { id: quizId, courseId },
      include: { questions: QUESTIONS_WITH_OPTIONS_INCLUDE },
    });
  }

  /** Creates a quiz with its complete question/option set in one nested write — see `CreateQuizDto`'s doc comment for why quiz authoring is one atomic action, not granular per-question CRUD. */
  create(
    tx: Prisma.TransactionClient,
    courseId: string,
    data: {
      title: string;
      description?: string;
      sectionId?: string;
      status?: 'draft' | 'published';
      passingScore?: number;
      maxAttempts?: number;
      questions: readonly {
        prompt: string;
        type: 'single_choice' | 'multiple_choice' | 'true_false';
        options: readonly { label: string; isCorrect: boolean }[];
      }[];
    },
  ): Promise<QuizWithQuestions> {
    return tx.quiz.create({
      data: {
        course: { connect: { id: courseId } },
        title: data.title,
        description: data.description,
        sectionId: data.sectionId,
        status: data.status,
        passingScore: data.passingScore,
        maxAttempts: data.maxAttempts,
        questions: {
          create: data.questions.map((question, index) => ({
            prompt: question.prompt,
            type: question.type,
            order: index,
            options: { create: question.options.map((option) => ({ ...option })) },
          })),
        },
      },
      include: { questions: QUESTIONS_WITH_OPTIONS_INCLUDE },
    });
  }

  /** Updates a quiz's own scalar fields — never its question set (see `replaceQuestions` for that, called separately so a caller that only changes the title never touches a single question/option row). */
  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.QuizUpdateInput,
  ): Promise<Quiz> {
    return tx.quiz.update({ where: { id }, data });
  }

  /** Replaces a quiz's entire question/option set — deletes every existing question (cascades to its options; a fresh attempt's `answers` JSONB is unaffected, matching that column's own "write-once-then-read-only" doc comment) and inserts the new set in its place. Matches `UpdateQuizDto`'s documented "questions, when present, replaces the whole set" contract. */
  async replaceQuestions(
    tx: Prisma.TransactionClient,
    quizId: string,
    questions: readonly {
      prompt: string;
      type: 'single_choice' | 'multiple_choice' | 'true_false';
      options: readonly { label: string; isCorrect: boolean }[];
    }[],
  ): Promise<void> {
    await tx.quizQuestion.deleteMany({ where: { quizId } });
    await tx.quiz.update({
      where: { id: quizId },
      data: {
        questions: {
          create: questions.map((question, index) => ({
            prompt: question.prompt,
            type: question.type,
            order: index,
            options: { create: question.options.map((option) => ({ ...option })) },
          })),
        },
      },
    });
  }

  /** Real SQL DELETE — cascades to `quiz_questions`/`quiz_question_options`/`quiz_attempts` (all `onDelete: Cascade`, unchanged). Matches `CourseSectionsRepository.delete`'s identical precedent: no soft-delete state machine exists for a quiz, unlike `Course`/`Academy`. */
  delete(tx: Prisma.TransactionClient, id: string): Promise<Quiz> {
    return tx.quiz.delete({ where: { id } });
  }
}
