/**
 * StudentAnalyticsRepository — the reads behind
 * `GET organizations/:id/student-analytics` /
 * `GET academies/:id/student-analytics` (Phase 9, roadmap finding CO11).
 *
 * Every method takes a `Prisma.TransactionClient` from
 * `TenancyContextService.runInTenantContext(organizationId)`, so
 * `enrollments`' own tenant RLS policy is the independent, database-level
 * half of the scoping — the `where` clauses below are the application
 * half, and neither is trusted alone. Scoping follows the same principle
 * `DashboardMetricsRepository` (Phase 8) established — one Academy, or
 * every Academy under one Organization, never an unscoped read — but
 * needs TWO filter shapes here rather than one, because `Enrollment` and
 * `Course` reach their Academy differently. See `courseScope` and
 * `enrollmentScope` below.
 *
 * See `student-analytics.contract.ts` for the definition behind every
 * figure produced here. Nothing in this file estimates, samples or
 * extrapolates.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export interface StudentAnalyticsScope {
  readonly organizationId: string;
  readonly academyId?: string;
}

/** The one enrolment shape every metric below is derived from — read once, aggregated in memory, so the funnel, the trend series and the at-risk list can never disagree with each other. */
export type AnalyticsEnrollmentRow = {
  id: string;
  studentId: string;
  courseId: string;
  academyId: string;
  status: string;
  enrolledAt: Date | null;
  completedAt: Date | null;
  student: { id: string; name: string };
  course: { id: string; title: string };
  progress: {
    completedLessons: number;
    totalLessons: number;
    completionState: string;
    updatedAt: Date;
  } | null;
};

/** A quiz the student has scored at least one attempt on, with whether any attempt passed — the `failing_quiz` at-risk signal. */
export type AnalyticsQuizOutcomeRow = {
  studentId: string;
  courseId: string;
  everPassed: boolean;
};

@Injectable()
export class StudentAnalyticsRepository {
  /**
   * A filter shaped for `Course`, which carries BOTH a scalar `academyId`
   * and an `academy` relation.
   */
  private courseScope(
    scope: StudentAnalyticsScope,
  ): { academyId: string } | { academy: { organizationId: string } } {
    return scope.academyId
      ? { academyId: scope.academyId }
      : { academy: { organizationId: scope.organizationId } };
  }

  /**
   * The same scope shaped for `Enrollment`, which deliberately does NOT
   * have an `academy` relation — only the denormalized `academyId` scalar
   * (see the model's own comment about avoiding a join on the hot path).
   * The organization case therefore reaches the organization through
   * `course.academy`, the relation that does exist. Getting this wrong is
   * not a silent scoping bug — Prisma rejects the unknown argument
   * outright — but the two shapes are separated here so the distinction
   * is explicit rather than rediscovered.
   */
  private enrollmentScope(
    scope: StudentAnalyticsScope,
  ): { academyId: string } | { course: { academy: { organizationId: string } } } {
    return scope.academyId
      ? { academyId: scope.academyId }
      : { course: { academy: { organizationId: scope.organizationId } } };
  }

  /**
   * Every REAL seat in scope — `enrolled` or `completed` only. The other
   * `EnrollmentStatus` values (`available`/`pending`/`unavailable`)
   * describe a course a student may take, not one they hold, and counting
   * them would inflate every figure downstream.
   */
  findEnrollments(
    tx: Prisma.TransactionClient,
    scope: StudentAnalyticsScope,
    take: number,
  ): Promise<AnalyticsEnrollmentRow[]> {
    return tx.enrollment.findMany({
      where: {
        ...this.enrollmentScope(scope),
        status: { in: ['enrolled', 'completed'] },
      },
      select: {
        id: true,
        studentId: true,
        courseId: true,
        academyId: true,
        status: true,
        enrolledAt: true,
        completedAt: true,
        student: { select: { id: true, name: true } },
        course: { select: { id: true, title: true } },
        progress: {
          select: {
            completedLessons: true,
            totalLessons: true,
            completionState: true,
            updatedAt: true,
          },
        },
      },
      orderBy: { enrolledAt: 'desc' },
      take,
    }) as unknown as Promise<AnalyticsEnrollmentRow[]>;
  }

  /**
   * Per (student, course), whether any attempt on any quiz in that course
   * has passed. Read as raw attempt rows and folded in the service rather
   * than as a SQL aggregate so the "scored at least once" and "never
   * passed" halves of the `failing_quiz` rule stay visible in one place.
   * Only attempts that carry a real score are considered — an unscored
   * attempt is not evidence of failing.
   */
  async findQuizOutcomes(
    tx: Prisma.TransactionClient,
    scope: StudentAnalyticsScope,
    take: number,
  ): Promise<AnalyticsQuizOutcomeRow[]> {
    const rows = (await tx.quizAttempt.findMany({
      where: {
        score: { not: null },
        quiz: { course: this.courseScope(scope) },
      },
      select: {
        studentId: true,
        passed: true,
        quiz: { select: { courseId: true } },
      },
      take,
    })) as unknown as {
      studentId: string;
      passed: boolean | null;
      quiz: { courseId: string };
    }[];

    const byKey = new Map<string, AnalyticsQuizOutcomeRow>();
    for (const row of rows) {
      const key = `${row.studentId}:${row.quiz.courseId}`;
      const existing = byKey.get(key);
      if (existing) {
        byKey.set(key, {
          ...existing,
          everPassed: existing.everPassed || row.passed === true,
        });
      } else {
        byKey.set(key, {
          studentId: row.studentId,
          courseId: row.quiz.courseId,
          everPassed: row.passed === true,
        });
      }
    }
    return [...byKey.values()];
  }
}
