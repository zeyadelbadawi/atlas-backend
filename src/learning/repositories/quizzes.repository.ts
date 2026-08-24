/**
 * QuizzesRepository — read-only for quizzes/questions/options (no write
 * endpoint in P6, see `learning.module.ts`'s doc comment), read+write for
 * `quiz_attempts` (the one student-owned, mutable P6 quiz table). Every
 * method takes a `Prisma.TransactionClient`, matching every other
 * repository in this codebase's established rule.
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
}
