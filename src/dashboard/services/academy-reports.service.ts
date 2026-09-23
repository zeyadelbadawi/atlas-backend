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
 * Reads are bounded and aggregated in memory (the `StudentAnalyticsService`
 * precedent) so a report's totals, breakdowns and top-N lists are one
 * consistent snapshot; `truncated` is set when the ceiling was hit.
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import {
  AcademyReportsRepository,
  type AccessLogRow,
  type IntegrityEventRow,
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
const MAX_EVENT_ROWS = 50_000;
const MAX_ACCESS_ROWS = 50_000;
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

    const rows = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      (tx) =>
        this.academyReportsRepository.findIntegrityEvents(
          tx,
          academyId,
          new Date(window.from),
          MAX_EVENT_ROWS,
        ),
    );

    return { academyId, window, ...this.aggregateIntegrity(rows) };
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

    const { rows, titles } = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        const accessRows = await this.academyReportsRepository.findAccessLogRows(
          tx,
          academyId,
          new Date(window.from),
          MAX_ACCESS_ROWS,
        );
        const courseIds = [...new Set(accessRows.map((row) => row.courseId))];
        const courseTitles = await this.academyReportsRepository.findCourseTitles(
          tx,
          courseIds,
        );
        return { rows: accessRows, titles: courseTitles };
      },
    );

    return { academyId, window, ...this.aggregateSharing(rows, titles) };
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
    rows: readonly IntegrityEventRow[],
  ): Omit<AcademyIntegrityReportResponse, 'academyId' | 'window'> {
    const byType = new Map<string, number>();
    const attempts = new Set<string>();
    const perCourseEvents = new Map<string, number>();
    const perCourseAttempts = new Map<string, Set<string>>();
    const titles = new Map<string, string>();
    let counted = 0;

    for (const row of rows) {
      increment(byType, row.type);
      attempts.add(row.attemptId);
      if (row.counted) counted += 1;
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
      totalEvents: rows.length,
      countedEvents: counted,
      attemptsWithEvents: attempts.size,
      byType: toRecord(byType),
      topCourses,
      truncated: rows.length >= MAX_EVENT_ROWS,
    };
  }

  private aggregateSharing(
    rows: readonly AccessLogRow[],
    titles: ReadonlyMap<string, string>,
  ): Omit<AcademySharingReportResponse, 'academyId' | 'window'> {
    let granted = 0;
    let refused = 0;
    const byReason = new Map<string, number>();
    const users = new Set<string>();
    const devices = new Set<string>();
    const perCourse = new Map<string, number>();
    const perUser = new Map<string, number>();
    const userNames = new Map<string, string | null>();

    for (const row of rows) {
      if (row.result === 'granted') {
        granted += 1;
        continue;
      }
      refused += 1;
      increment(byReason, row.reason ?? 'other');
      if (row.userId) {
        users.add(row.userId);
        increment(perUser, row.userId);
        userNames.set(row.userId, row.userName);
      }
      if (row.deviceId) devices.add(row.deviceId);
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
      distinctUsersRefused: users.size,
      distinctDevicesRefused: devices.size,
      topCourses,
      topUsers,
      truncated: rows.length >= MAX_ACCESS_ROWS,
    };
  }
}
