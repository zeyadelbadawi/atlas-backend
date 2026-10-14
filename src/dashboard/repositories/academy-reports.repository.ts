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
 * B0-ANL-03 — the headline figures come from uncapped grouped counts
 * (`count*` methods), so they cover the whole window however busy the
 * academy is. Only the top-N lists are built from the capped, newest-first
 * row reads (`find*` methods).
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

export interface IntegrityHeadlineCounts {
  readonly byTypeAndCounted: readonly {
    readonly type: QuizAttemptEventType;
    readonly counted: boolean;
    readonly events: number;
  }[];
  readonly attemptsWithEvents: number;
}

export interface SharingHeadlineCounts {
  readonly byResultAndReason: readonly {
    readonly result: ContentAccessResult;
    readonly reason: string | null;
    readonly decisions: number;
  }[];
  readonly distinctUsersRefused: number;
  readonly distinctDevicesRefused: number;
}

@Injectable()
export class AcademyReportsRepository {
  /** Exact integrity headline counts for THIS academy since `since` (no cap). */
  async countIntegrityEvents(
    tx: Prisma.TransactionClient,
    academyId: string,
    since: Date,
  ): Promise<IntegrityHeadlineCounts> {
    const groups = await tx.quizAttemptEvent.groupBy({
      by: ['type', 'counted'],
      where: {
        serverAt: { gte: since },
        attempt: { quiz: { course: { academyId } } },
      },
      _count: { _all: true },
    });
    const attemptsWithEvents = await tx.quizAttempt.count({
      where: {
        quiz: { course: { academyId } },
        events: { some: { serverAt: { gte: since } } },
      },
    });
    return {
      byTypeAndCounted: groups.map((group) => ({
        type: group.type,
        counted: group.counted,
        events: group._count._all,
      })),
      attemptsWithEvents,
    };
  }

  /** Exact sharing headline counts for THIS academy since `since` (no cap). */
  async countAccessDecisions(
    tx: Prisma.TransactionClient,
    academyId: string,
    since: Date,
  ): Promise<SharingHeadlineCounts> {
    const window = { academyId, createdAt: { gte: since } };
    const groups = await tx.contentAccessLog.groupBy({
      by: ['result', 'reason'],
      where: window,
      _count: { _all: true },
    });
    // One row per distinct refused user / device: bounded by the academy's
    // learners and their devices, not by the number of decisions.
    const users = await tx.contentAccessLog.groupBy({
      by: ['userId'],
      where: { ...window, result: 'refused', userId: { not: null } },
    });
    const devices = await tx.contentAccessLog.groupBy({
      by: ['deviceId'],
      where: { ...window, result: 'refused', deviceId: { not: null } },
    });
    return {
      byResultAndReason: groups.map((group) => ({
        result: group.result,
        reason: group.reason,
        decisions: group._count._all,
      })),
      distinctUsersRefused: users.length,
      distinctDevicesRefused: devices.length,
    };
  }

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
