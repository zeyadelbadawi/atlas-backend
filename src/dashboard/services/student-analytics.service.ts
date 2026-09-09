/**
 * StudentAnalyticsService — assembles the Client Owner's student progress
 * rollup (Phase 9, roadmap finding CO11).
 *
 * Authorization mirrors `DashboardService` exactly, for the same reasons
 * documented there and hardened in Phase 8: the organization-wide view
 * requires the owner-exclusive `tenant.dashboard.view` permission (a
 * Manager legitimately holds an organization MEMBERSHIP, so membership
 * alone would let them read aggregates spanning a sibling Academy), and
 * the academy view requires a real `academy_members` row for THAT academy
 * unless the caller is the organization's owner. Neither method accepts a
 * scope id from a query string or body — both come from the guard that
 * ran.
 *
 * Every metric is computed from one read of the scope's real enrolments,
 * folded in memory, so the funnel, the cohort series and the at-risk list
 * can never disagree with one another. See
 * `student-analytics.contract.ts` for the exact definition of each, and
 * for the explicit list of things this phase does NOT measure because
 * Atlas does not record the events they would need.
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import {
  StudentAnalyticsRepository,
  type AnalyticsEnrollmentRow,
  type StudentAnalyticsScope,
} from '../repositories/student-analytics.repository';
import {
  AT_RISK_INACTIVITY_DAYS,
  type AtRiskReason,
  type AtRiskStudentResponse,
  type CohortTrendPointResponse,
  type CompletionFunnelResponse,
  type StudentAnalyticsResponse,
} from '../dto/student-analytics.contract';

/** Bounded reads — an analytics rollup must stay predictable on a large tenant. Both are far above any realistic single-academy volume. */
const MAX_ENROLLMENTS = 20_000;
const MAX_QUIZ_ATTEMPTS = 50_000;
/** Rows returned in the at-risk table. The true total is reported separately as `atRiskTotal`, so the UI never implies the list is exhaustive when it is not. */
const MAX_AT_RISK_ROWS = 100;
/** Months of cohort history returned. */
const TREND_MONTHS = 6;

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

@Injectable()
export class StudentAnalyticsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly studentAnalyticsRepository: StudentAnalyticsRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
  ) {}

  /** The Client Owner's organization-wide rollup. The caller's owner permission is verified by the controller before this is reached. */
  getForOrganization(organizationId: string): Promise<StudentAnalyticsResponse> {
    return this.build({ organizationId });
  }

  /** One Academy's rollup. See `DashboardService.getForAcademy` — identical two-tier rule, so a Manager of Academy A cannot read Academy B's. */
  async getForAcademy(
    organizationId: string,
    academyId: string,
    userId: string,
    isOrganizationOwner: boolean,
  ): Promise<StudentAnalyticsResponse> {
    if (!isOrganizationOwner) {
      const membership = await this.tenancyContextService.runInTenantContext(
        organizationId,
        (tx) => this.academyMembersRepository.findForUserInAcademy(tx, academyId, userId),
      );
      if (!membership) {
        throw new ForbiddenException({ messageKey: 'errors.tenancy.notAMember' });
      }
    }

    return this.build({ organizationId, academyId });
  }

  private async build(scope: StudentAnalyticsScope): Promise<StudentAnalyticsResponse> {
    const now = new Date();
    const { enrollments, quizOutcomes } =
      await this.tenancyContextService.runInTenantContext(
        scope.organizationId,
        async (tx) => {
          const [enrollmentRows, quizRows] = await Promise.all([
            this.studentAnalyticsRepository.findEnrollments(tx, scope, MAX_ENROLLMENTS),
            this.studentAnalyticsRepository.findQuizOutcomes(
              tx,
              scope,
              MAX_QUIZ_ATTEMPTS,
            ),
          ]);
          return { enrollments: enrollmentRows, quizOutcomes: quizRows };
        },
      );

    const failingByKey = new Set(
      quizOutcomes
        .filter((outcome) => !outcome.everPassed)
        .map((outcome) => `${outcome.studentId}:${outcome.courseId}`),
    );

    const atRisk = this.buildAtRisk(enrollments, failingByKey, now);
    const { from, to, points } = this.buildCohortTrends(enrollments, now);

    return {
      scope: scope.academyId
        ? {
            type: 'academy',
            organizationId: scope.organizationId,
            academyId: scope.academyId,
          }
        : { type: 'organization', organizationId: scope.organizationId },
      window: { from, to },
      funnel: this.buildFunnel(enrollments),
      cohortTrends: points,
      atRiskStudents: atRisk.slice(0, MAX_AT_RISK_ROWS),
      atRiskTotal: atRisk.length,
      inactivityThresholdDays: AT_RISK_INACTIVITY_DAYS,
    };
  }

  /** See the contract's COMPLETION FUNNEL definition — three real counts, each a strict superset of the next. */
  private buildFunnel(
    enrollments: readonly AnalyticsEnrollmentRow[],
  ): CompletionFunnelResponse {
    let started = 0;
    let completed = 0;
    for (const enrollment of enrollments) {
      if ((enrollment.progress?.completedLessons ?? 0) > 0) started += 1;
      if (enrollment.progress?.completionState === 'completed') completed += 1;
    }
    return { enrolled: enrollments.length, started, completed };
  }

  /**
   * See the contract's COHORT TRENDS definition. The series is built from
   * a fixed, continuous list of the last `TREND_MONTHS` months so a month
   * with no activity is an explicit real zero rather than a gap the UI
   * would have to interpolate across.
   */
  private buildCohortTrends(
    enrollments: readonly AnalyticsEnrollmentRow[],
    now: Date,
  ): { from: string; to: string; points: CohortTrendPointResponse[] } {
    const months: string[] = [];
    for (let offset = TREND_MONTHS - 1; offset >= 0; offset -= 1) {
      months.push(
        monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1))),
      );
    }
    const windowStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (TREND_MONTHS - 1), 1),
    );

    const newByMonth = new Map<string, number>();
    const completedByMonth = new Map<string, number>();
    for (const enrollment of enrollments) {
      // A null `enrolledAt` is excluded rather than attributed to an
      // invented date — see the contract.
      if (enrollment.enrolledAt && enrollment.enrolledAt >= windowStart) {
        const key = monthKey(enrollment.enrolledAt);
        newByMonth.set(key, (newByMonth.get(key) ?? 0) + 1);
      }
      if (enrollment.completedAt && enrollment.completedAt >= windowStart) {
        const key = monthKey(enrollment.completedAt);
        completedByMonth.set(key, (completedByMonth.get(key) ?? 0) + 1);
      }
    }

    return {
      from: windowStart.toISOString(),
      to: now.toISOString(),
      points: months.map((month) => ({
        month,
        newEnrollments: newByMonth.get(month) ?? 0,
        completions: completedByMonth.get(month) ?? 0,
      })),
    };
  }

  /**
   * See the contract's AT-RISK definition. Every returned row carries the
   * concrete reasons that fired, so the UI can always explain the flag —
   * a student is never labelled at risk without a stated, checkable fact.
   */
  private buildAtRisk(
    enrollments: readonly AnalyticsEnrollmentRow[],
    failingByKey: ReadonlySet<string>,
    now: Date,
  ): AtRiskStudentResponse[] {
    const cutoff = new Date(
      now.getTime() - AT_RISK_INACTIVITY_DAYS * 24 * 60 * 60 * 1000,
    );
    const rows: AtRiskStudentResponse[] = [];

    for (const enrollment of enrollments) {
      // Only genuinely in-progress seats can be "at risk" — a completed
      // course is an outcome, not a concern.
      if (enrollment.status !== 'enrolled') continue;
      if (enrollment.progress?.completionState === 'completed') continue;

      const reasons: AtRiskReason[] = [];
      const completedLessons = enrollment.progress?.completedLessons ?? 0;
      const lastProgressAt = enrollment.progress?.updatedAt ?? null;

      if (completedLessons === 0) {
        // Nothing finished yet — only a concern once they have had time.
        if (enrollment.enrolledAt && enrollment.enrolledAt < cutoff) {
          reasons.push('no_progress');
        }
      } else if (lastProgressAt && lastProgressAt < cutoff) {
        reasons.push('stalled');
      }

      if (failingByKey.has(`${enrollment.studentId}:${enrollment.courseId}`)) {
        reasons.push('failing_quiz');
      }

      if (reasons.length === 0) continue;

      rows.push({
        studentId: enrollment.studentId,
        studentName: enrollment.student.name,
        courseId: enrollment.courseId,
        courseTitle: enrollment.course.title,
        academyId: enrollment.academyId,
        completedLessons,
        totalLessons: enrollment.progress?.totalLessons ?? 0,
        lastProgressAt: lastProgressAt?.toISOString() ?? null,
        reasons,
      });
    }

    // Most reasons first, then least progress — the rows an owner most
    // needs to act on surface at the top of the capped list.
    return rows.sort(
      (a, b) =>
        b.reasons.length - a.reasons.length || a.completedLessons - b.completedLessons,
    );
  }
}
