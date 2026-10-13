/**
 * AcademyReportsService — the owner reports (P64 Phase 4, master plan
 * §D.6/§E.5): integrity summaries and sharing signals for one academy.
 *
 * Authorization is two independent gates that must agree:
 *   1. here — the caller is the organization owner, or an ACTIVE academy
 *      member whose role is owner/administrator/manager (the exact role set
 *      `can_manage_academy_students()` grants); anyone else is refused
 *      with 403 before any read;
 *   2. RLS — the reads run in `runInTenantAndUserContext`, so
 *      `quiz_attempt_events_tenant_select` (organization GUC) and
 *      `content_access_log_manager_select` (user GUC) each scope the rows
 *      on their own. A wrong guard cannot widen the data; a wrong policy
 *      cannot bypass the guard.
 *
 * B0-ANL-03 — the headline figures (totals, per-type / per-reason
 * breakdowns, distinct counts) are uncapped grouped counts over the whole
 * window, so a busy academy never sees a silently short total. Only the
 * top-N lists are aggregated in memory from a bounded, newest-first read;
 * `truncated` says that read hit its ceiling, i.e. the lists rank the most
 * recent rows of the window rather than all of them.
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import {
  AcademyReportsRepository,
  type AccessLogRow,
  type IntegrityEventRow,
  type IntegrityHeadlineCounts,
  type SharingHeadlineCounts,
} from '../repositories/academy-reports.repository';
import type {
  AcademyIntegrityReportResponse,
  AcademySharingReportResponse,
  IntegrityReportCourseRow,
  ReportWindowResponse,
  SharingReportCourseRow,
  SharingReportUserRow,
} from '../dto/academy-reports.contract';
import { REPORT_WINDOW_DEFAULT_DAYS } from '../dto/academy-reports-query.dto';

/** Mirrors `can_manage_academy_students()` exactly. */
const REPORT_ROLES = new Set(['owner', 'administrator', 'manager']);
/** Ceilings of the newest-first reads the top-N lists are ranked from. */
export const REPORT_LIST_SAMPLE_LIMITS = {
  eventRows: 50_000,
  accessRows: 50_000,
} as const;
const TOP_N = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

function increment(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function toRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

@Injectable()
export class AcademyReportsService {
  /** The list-sample ceilings; an instance field so an e2e test can lower them. */
  sampleLimits: { eventRows: number; accessRows: number } = {
    ...REPORT_LIST_SAMPLE_LIMITS,
  };

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly academyReportsRepository: AcademyReportsRepository,
  ) {}

  async getIntegrityReport(
    organizationId: string,
    academyId: string,
    userId: string,
    isOrganizationOwner: boolean,
    days: number | undefined,
  ): Promise<AcademyIntegrityReportResponse> {
    await this.assertCanReport(organizationId, academyId, userId, isOrganizationOwner);
    const window = this.window(days);

    const since = new Date(window.from);
    const limit = this.sampleLimits.eventRows;
    const { counts, rows } = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => ({
        counts: await this.academyReportsRepository.countIntegrityEvents(
          tx,
          academyId,
          since,
        ),
        rows: await this.academyReportsRepository.findIntegrityEvents(
          tx,
          academyId,
          since,
          limit,
        ),
      }),
    );

    return { academyId, window, ...this.aggregateIntegrity(counts, rows, limit) };
  }

  async getSharingReport(
    organizationId: string,
    academyId: string,
    userId: string,
    isOrganizationOwner: boolean,
    days: number | undefined,
  ): Promise<AcademySharingReportResponse> {
    await this.assertCanReport(organizationId, academyId, userId, isOrganizationOwner);
    const window = this.window(days);

    const since = new Date(window.from);
    const limit = this.sampleLimits.accessRows;
    const { counts, rows, titles } =
      await this.tenancyContextService.runInTenantAndUserContext(
        organizationId,
        userId,
        async (tx) => {
          const headline = await this.academyReportsRepository.countAccessDecisions(
            tx,
            academyId,
            since,
          );
          const accessRows = await this.academyReportsRepository.findAccessLogRows(
            tx,
            academyId,
            since,
            limit,
          );
          const courseIds = [...new Set(accessRows.map((row) => row.courseId))];
          const courseTitles = await this.academyReportsRepository.findCourseTitles(
            tx,
            courseIds,
          );
          return { counts: headline, rows: accessRows, titles: courseTitles };
        },
      );

    return { academyId, window, ...this.aggregateSharing(counts, rows, titles, limit) };
  }

  /**
   * Gate 1 (see class doc). The organization owner is implicitly allowed —
   * the same exemption `AcademyScopeGuard`/`StudentAnalyticsService` grant.
   * Everyone else must hold an ACTIVE academy membership in `REPORT_ROLES`.
   */
  private async assertCanReport(
    organizationId: string,
    academyId: string,
    userId: string,
    isOrganizationOwner: boolean,
  ): Promise<void> {
    if (isOrganizationOwner) return;
    const membership = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.academyMembersRepository.findForUserInAcademy(tx, academyId, userId),
    );
    if (
      !membership ||
      membership.status !== 'active' ||
      !REPORT_ROLES.has(membership.role)
    ) {
      throw new ForbiddenException({ messageKey: 'errors.tenancy.notAMember' });
    }
  }

  private window(days: number | undefined): ReportWindowResponse {
    const resolvedDays = days ?? REPORT_WINDOW_DEFAULT_DAYS;
    const to = new Date();
    const from = new Date(to.getTime() - resolvedDays * DAY_MS);
    return { from: from.toISOString(), to: to.toISOString(), days: resolvedDays };
  }

  private aggregateIntegrity(
    counts: IntegrityHeadlineCounts,
    rows: readonly IntegrityEventRow[],
    limit: number,
  ): Omit<AcademyIntegrityReportResponse, 'academyId' | 'window'> {
    const byType = new Map<string, number>();
    let totalEvents = 0;
    let counted = 0;
    for (const group of counts.byTypeAndCounted) {
      increment(byType, group.type, group.events);
      totalEvents += group.events;
      if (group.counted) counted += group.events;
    }

    const perCourseEvents = new Map<string, number>();
    const perCourseAttempts = new Map<string, Set<string>>();
    const titles = new Map<string, string>();

    for (const row of rows) {
      increment(perCourseEvents, row.courseId);
      titles.set(row.courseId, row.courseTitle);
      const set = perCourseAttempts.get(row.courseId) ?? new Set<string>();
      set.add(row.attemptId);
      perCourseAttempts.set(row.courseId, set);
    }

    const topCourses: IntegrityReportCourseRow[] = [...perCourseEvents.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, TOP_N)
      .map(([courseId, events]) => ({
        courseId,
        courseTitle: titles.get(courseId) ?? '',
        events,
        attemptsWithEvents: perCourseAttempts.get(courseId)?.size ?? 0,
      }));

    return {
      totalEvents,
      countedEvents: counted,
      attemptsWithEvents: counts.attemptsWithEvents,
      byType: toRecord(byType),
      topCourses,
      truncated: rows.length >= limit,
    };
  }

  private aggregateSharing(
    counts: SharingHeadlineCounts,
    rows: readonly AccessLogRow[],
    titles: ReadonlyMap<string, string>,
    limit: number,
  ): Omit<AcademySharingReportResponse, 'academyId' | 'window'> {
    let granted = 0;
    let refused = 0;
    const byReason = new Map<string, number>();
    for (const group of counts.byResultAndReason) {
      if (group.result === 'granted') {
        granted += group.decisions;
        continue;
      }
      refused += group.decisions;
      increment(byReason, group.reason ?? 'other', group.decisions);
    }

    const perCourse = new Map<string, number>();
    const perUser = new Map<string, number>();
    const userNames = new Map<string, string | null>();

    for (const row of rows) {
      if (row.result === 'granted') continue;
      if (row.userId) {
        increment(perUser, row.userId);
        userNames.set(row.userId, row.userName);
      }
      increment(perCourse, row.courseId);
    }

    const topCourses: SharingReportCourseRow[] = [...perCourse.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, TOP_N)
      .map(([courseId, refusals]) => ({
        courseId,
        courseTitle: titles.get(courseId) ?? '',
        refusals,
      }));

    const topUsers: SharingReportUserRow[] = [...perUser.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, TOP_N)
      .map(([userId, refusals]) => ({
        userId,
        userName: userNames.get(userId) ?? undefined,
        refusals,
      }));

    return {
      granted,
      refused,
      refusedByReason: toRecord(byReason),
      distinctUsersRefused: counts.distinctUsersRefused,
      distinctDevicesRefused: counts.distinctDevicesRefused,
      topCourses,
      topUsers,
      truncated: rows.length >= limit,
    };
  }
}
