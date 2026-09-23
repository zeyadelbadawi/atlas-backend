/**
 * AcademyReportsRepository — the two bounded reads behind the owner reports
 * (P64 Phase 4). Every method takes a `Prisma.TransactionClient` and runs
 * under the caller's RLS context set by the service: `quiz_attempt_events`
 * is readable through `quiz_attempt_events_tenant_select` (organization
 * GUC) and `content_access_log` only through
 * `content_access_log_manager_select` (`can_manage_academy_students` on the
 * user GUC) — so a caller who is not an owner/administrator/manager of the
 * academy gets an EMPTY read here even if a guard were wrong. The service
 * checks the same roles first; the two gates agree independently.
 *
 * Reads are capped (`take`) and aggregated in memory by the service — the
 * `StudentAnalyticsRepository` precedent — so no two numbers in a report
 * can come from different snapshots.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, QuizAttemptEventType, ContentAccessResult } from '@prisma/client';

export interface IntegrityEventRow {
  readonly attemptId: string;
  readonly type: QuizAttemptEventType;
  readonly counted: boolean;
  readonly courseId: string;
  readonly courseTitle: string;
}

export interface AccessLogRow {
  readonly result: ContentAccessResult;
  readonly reason: string | null;
  readonly userId: string | null;
  readonly userName: string | null;
  readonly deviceId: string | null;
  readonly courseId: string;
}

@Injectable()
export class AcademyReportsRepository {
  /** Attempt events of THIS academy's quizzes since `since`, newest first, capped. */
  async findIntegrityEvents(
    tx: Prisma.TransactionClient,
    academyId: string,
    since: Date,
    take: number,
  ): Promise<IntegrityEventRow[]> {
    const rows = await tx.quizAttemptEvent.findMany({
      where: {
        serverAt: { gte: since },
        attempt: { quiz: { course: { academyId } } },
      },
      select: {
        attemptId: true,
        type: true,
        counted: true,
        attempt: {
          select: { quiz: { select: { course: { select: { id: true, title: true } } } } },
        },
      },
      orderBy: { serverAt: 'desc' },
      take,
    });
    return rows.map((row) => ({
      attemptId: row.attemptId,
      type: row.type,
      counted: row.counted,
      courseId: row.attempt.quiz.course.id,
      courseTitle: row.attempt.quiz.course.title,
    }));
  }

  /** Content-access decisions for THIS academy since `since`, newest first, capped. */
  async findAccessLogRows(
    tx: Prisma.TransactionClient,
    academyId: string,
    since: Date,
    take: number,
  ): Promise<AccessLogRow[]> {
    const rows = await tx.contentAccessLog.findMany({
      where: { academyId, createdAt: { gte: since } },
      select: {
        result: true,
        reason: true,
        userId: true,
        deviceId: true,
        courseId: true,
        user: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return rows.map((row) => ({
      result: row.result,
      reason: row.reason,
      userId: row.userId,
      userName: row.user?.name ?? null,
      deviceId: row.deviceId,
      courseId: row.courseId,
    }));
  }

  /** Titles for the course ids a sharing report mentions (`content_access_log` has no course relation). */
  async findCourseTitles(
    tx: Prisma.TransactionClient,
    courseIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (courseIds.length === 0) return new Map();
    const courses = await tx.course.findMany({
      where: { id: { in: [...courseIds] } },
      select: { id: true, title: true },
    });
    return new Map(courses.map((course) => [course.id, course.title]));
  }
}
