/**
 * P64 Phase 3 — data access for the v2 attempt lifecycle: attempts with
 * their engine columns, integrity events, materialised results and
 * per-student overrides. Every method runs inside a caller-supplied
 * transaction whose RLS context the caller established (learner = user
 * context, reviewer = user context via the review tier).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  QuizAttempt,
  QuizAttemptEvent,
  QuizAttemptEventType,
  QuizResult,
  QuizStudentOverride,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface DueAttemptRef {
  readonly id: string;
  readonly student_id: string;
  readonly deadline_at: Date;
}

@Injectable()
export class QuizAttemptsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(tx: Prisma.TransactionClient, id: string): Promise<QuizAttempt | null> {
    return tx.quizAttempt.findUnique({ where: { id } });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.QuizAttemptUpdateInput,
  ): Promise<QuizAttempt> {
    return tx.quizAttempt.update({ where: { id }, data });
  }

  /**
   * Conditional finalisation guard: updates only while the row is still
   * `in_progress`, so the job, the sweep and a concurrent learner submit
   * cannot each finalise the same attempt. Returns the number of rows
   * changed (0 = someone else got there first).
   */
  async updateIfInProgress(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.QuizAttemptUpdateManyMutationInput,
  ): Promise<number> {
    const result = await tx.quizAttempt.updateMany({
      where: { id, status: 'in_progress' },
      data,
    });
    return result.count;
  }

  findFinalizedForStudent(
    tx: Prisma.TransactionClient,
    studentId: string,
    quizId: string,
  ): Promise<QuizAttempt[]> {
    return tx.quizAttempt.findMany({
      where: {
        studentId,
        quizId,
        status: { in: ['submitted', 'passed', 'failed', 'expired'] },
      },
      orderBy: { attemptNumber: 'asc' },
    });
  }

  countForStudent(
    tx: Prisma.TransactionClient,
    studentId: string,
    quizId: string,
  ): Promise<number> {
    return tx.quizAttempt.count({ where: { studentId, quizId } });
  }

  // --- events -------------------------------------------------------------

  createEvents(
    tx: Prisma.TransactionClient,
    attemptId: string,
    events: readonly {
      readonly type: QuizAttemptEventType;
      readonly counted: boolean;
      readonly clientAt: Date | null;
      readonly serverAt: Date;
      readonly payload: Prisma.InputJsonValue | null;
    }[],
  ): Promise<number> {
    if (events.length === 0) return Promise.resolve(0);
    return tx.quizAttemptEvent
      .createMany({
        data: events.map((event) => ({
          attemptId,
          type: event.type,
          counted: event.counted,
          clientAt: event.clientAt,
          serverAt: event.serverAt,
          payload: event.payload ?? undefined,
        })),
      })
      .then((result) => result.count);
  }

  findEvents(
    tx: Prisma.TransactionClient,
    attemptId: string,
  ): Promise<QuizAttemptEvent[]> {
    return tx.quizAttemptEvent.findMany({
      where: { attemptId },
      orderBy: { serverAt: 'asc' },
      take: 2_000,
    });
  }

  /** Last counted server time per type + last hidden time — the debounce state. */
  async findIntegrityState(
    tx: Prisma.TransactionClient,
    attemptId: string,
  ): Promise<{
    lastCountedAt: Map<QuizAttemptEventType, Date>;
    lastHiddenAt: Date | null;
  }> {
    const rows = await tx.quizAttemptEvent.findMany({
      where: { attemptId },
      orderBy: { serverAt: 'desc' },
      take: 200,
      select: { type: true, counted: true, serverAt: true },
    });
    const lastCountedAt = new Map<QuizAttemptEventType, Date>();
    let lastHiddenAt: Date | null = null;
    for (const row of rows) {
      if (row.counted && !lastCountedAt.has(row.type))
        lastCountedAt.set(row.type, row.serverAt);
      if (row.type === 'visibility_hidden' && lastHiddenAt === null)
        lastHiddenAt = row.serverAt;
      if (row.type === 'visibility_visible' && lastHiddenAt === null) break;
    }
    return { lastCountedAt, lastHiddenAt };
  }

  // --- results --------------------------------------------------------------

  upsertResult(
    tx: Prisma.TransactionClient,
    quizId: string,
    studentId: string,
    data: {
      readonly attemptsCount: number;
      readonly bestScore: number | null;
      readonly latestScore: number | null;
      readonly effectiveScore: number | null;
      readonly passed: boolean;
      readonly effectiveAttemptId: string | null;
      readonly pendingGrading: boolean;
    },
  ): Promise<QuizResult> {
    const payload = { ...data, computedAt: new Date() };
    return tx.quizResult.upsert({
      where: { quizId_studentId: { quizId, studentId } },
      create: { quizId, studentId, ...payload },
      update: payload,
    });
  }

  findResultsForStudentInCourse(
    tx: Prisma.TransactionClient,
    studentId: string,
    courseId: string,
  ): Promise<QuizResult[]> {
    return tx.quizResult.findMany({ where: { studentId, quiz: { courseId } } });
  }

  findResult(
    tx: Prisma.TransactionClient,
    quizId: string,
    studentId: string,
  ): Promise<QuizResult | null> {
    return tx.quizResult.findUnique({
      where: { quizId_studentId: { quizId, studentId } },
    });
  }

  // --- overrides ------------------------------------------------------------

  findOverride(
    tx: Prisma.TransactionClient,
    quizId: string,
    studentId: string,
  ): Promise<QuizStudentOverride | null> {
    return tx.quizStudentOverride.findUnique({
      where: { quizId_studentId: { quizId, studentId } },
    });
  }

  findOverridesForQuiz(
    tx: Prisma.TransactionClient,
    quizId: string,
  ): Promise<QuizStudentOverride[]> {
    return tx.quizStudentOverride.findMany({
      where: { quizId },
      orderBy: { createdAt: 'asc' },
    });
  }

  upsertOverride(
    tx: Prisma.TransactionClient,
    quizId: string,
    studentId: string,
    createdById: string,
    data: {
      readonly timeMultiplier: number;
      readonly extraAttempts: number;
      readonly availableFrom: Date | null;
      readonly availableUntil: Date | null;
      readonly reason: string | null;
    },
  ): Promise<QuizStudentOverride> {
    return tx.quizStudentOverride.upsert({
      where: { quizId_studentId: { quizId, studentId } },
      create: { quizId, studentId, createdById, ...data },
      update: { ...data, createdById },
    });
  }

  deleteOverride(
    tx: Prisma.TransactionClient,
    quizId: string,
    studentId: string,
  ): Promise<number> {
    return tx.quizStudentOverride
      .deleteMany({ where: { quizId, studentId } })
      .then((result) => result.count);
  }

  // --- sweep ------------------------------------------------------------------

  /** Runs OUTSIDE any tenant context on purpose — see the definer's comment in the migration. */
  async findDueAttempts(limit: number): Promise<DueAttemptRef[]> {
    return this.prisma.$queryRaw<DueAttemptRef[]>(
      Prisma.sql`SELECT * FROM find_due_quiz_attempts(${limit}::int)`,
    );
  }

  /** 180-day retention on integrity events (Phase 4 §D.5); the DELETE policy bounds it independently. */
  pruneEventsOlderThan(tx: Prisma.TransactionClient, cutoff: Date): Promise<number> {
    return tx.quizAttemptEvent
      .deleteMany({ where: { serverAt: { lt: cutoff } } })
      .then((result) => result.count);
  }
}
