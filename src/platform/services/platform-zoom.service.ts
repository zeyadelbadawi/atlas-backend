/**
 * The Zoom Operations Center's data layer — Platform Owner only.
 *
 * EVERY NUMBER HERE COMES FROM A ROW THAT ALREADY EXISTS. Nothing is
 * derived from telemetry invented for a dashboard card: connection state
 * from `academy_live_provider_connections`, session state from
 * `live_sessions`, event state from `live_provider_events`, activity from
 * `audit_log_entries`. Where a metric had no source it was left out
 * rather than approximated — see the operations pages' own notes.
 *
 * READS RUN IN PLATFORM-OWNER CONTEXT, which is the only context that can
 * see across tenants, and is exactly the mechanism P46 established for
 * the webhook worker. The guard decides who may call this; RLS
 * independently agrees, because `is_platform_owner` is evaluated by
 * Postgres against the session variable rather than trusted from the
 * request. A member's context satisfies neither.
 *
 * BOUNDED BY CONSTRUCTION. The overview runs a fixed number of grouped
 * aggregates and three small capped lists; it never loads sessions or
 * events into memory to count them. The list endpoints paginate in the
 * database. There is no per-row follow-up query anywhere in this file.
 */
import { Injectable } from '@nestjs/common';
import type { LiveProviderConnectionStatus, Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { RecordingQuotaService } from '../../live-sessions/services/recording-quota.service';
import { MAX_RECONCILIATION_ATTEMPTS } from '../../live-sessions/queue/live-session-sweep.types';
import {
  buildPaginationMeta,
  type PaginatedResult,
} from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import {
  maskAccountId,
  type ZoomActivityRow,
  type ZoomAttentionItem,
  type ZoomConnectionRow,
  type ZoomConnectionStatus,
  type ZoomLiveSessionRow,
  type ZoomOverviewResponse,
  type ZoomAttendanceRow,
  type ZoomRecordingRow,
  type ZoomEventRow,
  type ZoomEventHealth,
  type ZoomHealthResponse,
  type ZoomHealthIssueGroup,
  type ZoomAcademyDetail,
} from '../dto/platform-zoom.contract';
import type {
  PlatformZoomConnectionsQueryDto,
  PlatformZoomSessionsQueryDto,
  PlatformZoomAttendanceQueryDto,
  PlatformZoomRecordingsQueryDto,
  PlatformZoomEventsQueryDto,
  PlatformZoomActivityQueryDto,
} from '../dto/platform-zoom-query.dto';

/** Connection states that mean "an operator should look at this". */
const ISSUE_STATUSES = [
  'revoked',
  'expired',
  'error',
  'reconnect_required',
] as const satisfies readonly LiveProviderConnectionStatus[];

/** Mutable copy for Prisma's `in:` filters, which reject readonly arrays. */
const ISSUE_STATUS_FILTER = (): LiveProviderConnectionStatus[] => [...ISSUE_STATUSES];

/** Membership test that accepts any string. */
const isIssueStatus = (status: string | undefined): boolean =>
  (ISSUE_STATUSES as readonly string[]).includes(status ?? '');

/** How far ahead "upcoming at risk" looks. Matches the page's own copy. */
const AT_RISK_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Caps on the overview's embedded lists, so the page stays bounded. */
const OVERVIEW_AT_RISK_LIMIT = 10;
const OVERVIEW_ACTIVITY_LIMIT = 10;

/** The five audit actions the Zoom integration actually writes. */
const ZOOM_AUDIT_ACTIONS: readonly string[] = [
  'live_provider.connected',
  'live_provider.disconnected',
  'live_provider.deauthorized',
  'live_session.created',
  'live_session.published',
];

/**
 * One select shape, used by both the overview's at-risk list and the
 * sessions page, so the two can never drift into showing different facts
 * about the same session.
 */
const SESSION_SELECT = {
  id: true,
  title: true,
  academyId: true,
  status: true,
  scheduledStartAt: true,
  scheduledEndAt: true,
  providerMeetingId: true,
  recordingEnabled: true,
  attendanceReconciledAt: true,
  reconciliationAttempts: true,
  failureReason: true,
  academy: {
    select: {
      name: true,
      organization: { select: { name: true } },
      liveProviderConnection: { select: { status: true } },
    },
  },
  course: { select: { title: true } },
  hostUser: { select: { name: true } },
  recording: { select: { status: true } },
} satisfies Prisma.LiveSessionSelect;

type SessionRow = Prisma.LiveSessionGetPayload<{ select: typeof SESSION_SELECT }>;

function toSessionRow(session: SessionRow): ZoomLiveSessionRow {
  const connectionStatus = session.academy.liveProviderConnection?.status;
  const unprovisioned = session.providerMeetingId === null;
  const connectionBroken =
    connectionStatus === undefined || isIssueStatus(connectionStatus);
  const pending = session.status === 'scheduled' || session.status === 'live';

  /*
    RISK IS DERIVED FROM STORED STATE, never guessed. A session is at risk
    when it still has to run AND either Atlas holds no provider meeting for
    it or its academy cannot currently reach Zoom.
  */
  const atRisk = pending && (unprovisioned || connectionBroken);
  const riskReason = !atRisk
    ? undefined
    : unprovisioned
      ? 'unprovisioned'
      : connectionStatus === undefined
        ? 'not_connected'
        : connectionStatus;

  return {
    id: session.id,
    title: session.title,
    academyId: session.academyId,
    academyName: session.academy.name,
    organizationName: session.academy.organization.name,
    courseTitle: session.course?.title,
    hostName: session.hostUser?.name,
    status: session.status,
    scheduledStartAt: session.scheduledStartAt.toISOString(),
    scheduledEndAt: session.scheduledEndAt.toISOString(),
    provisioned: !unprovisioned,
    recordingEnabled: session.recordingEnabled,
    recordingStatus: session.recording?.status,
    attendanceReconciledAt: session.attendanceReconciledAt?.toISOString(),
    reconciliationAttempts: session.reconciliationAttempts,
    failureReason: session.failureReason ?? undefined,
    atRisk,
    riskReason,
  };
}

@Injectable()
export class PlatformZoomService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly recordingQuotaService: RecordingQuotaService,
  ) {}

  /** Every read in this service goes through here. */
  private asPlatformOwner<T>(
    platformOwnerId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, work);
  }

  async getOverview(platformOwnerId: string): Promise<ZoomOverviewResponse> {
    const now = new Date();
    const horizon = new Date(now.getTime() + AT_RISK_WINDOW_MS);

    return this.asPlatformOwner(platformOwnerId, async (tx) => {
      const [
        connectionGroups,
        academyCount,
        connectionCount,
        sessionGroups,
        unprovisioned,
        eventGroups,
        atRiskRows,
        activityRows,
      ] = await Promise.all([
        tx.academyLiveProviderConnection.groupBy({
          by: ['status'],
          where: { providerKey: 'zoom' },
          _count: { _all: true },
        }),
        tx.academy.count(),
        tx.academyLiveProviderConnection.count({ where: { providerKey: 'zoom' } }),
        tx.liveSession.groupBy({ by: ['status'], _count: { _all: true } }),
        // A published session Atlas never got a meeting for.
        tx.liveSession.count({
          where: { providerMeetingId: null, status: { in: ['scheduled', 'live'] } },
        }),
        tx.liveProviderEvent.groupBy({ by: ['status'], _count: { _all: true } }),
        /*
          UPCOMING AT RISK. The risk is real and already recorded: the
          session is scheduled inside the window, and either Atlas never
          provisioned a meeting for it or its academy's connection is not
          in a state that can reach Zoom.
        */
        tx.liveSession.findMany({
          where: {
            status: { in: ['scheduled', 'live'] },
            scheduledStartAt: { gte: now, lte: horizon },
            OR: [
              { providerMeetingId: null },
              {
                academy: {
                  liveProviderConnection: { status: { in: ISSUE_STATUS_FILTER() } },
                },
              },
              { academy: { liveProviderConnection: { is: null } } },
            ],
          },
          orderBy: { scheduledStartAt: 'asc' },
          take: OVERVIEW_AT_RISK_LIMIT,
          select: SESSION_SELECT,
        }),
        tx.auditLogEntry.findMany({
          where: { action: { in: [...ZOOM_AUDIT_ACTIONS] } },
          orderBy: { occurredAt: 'desc' },
          take: OVERVIEW_ACTIVITY_LIMIT,
          select: {
            id: true,
            action: true,
            academyId: true,
            organizationId: true,
            occurredAt: true,
            actor: { select: { name: true } },
          },
        }),
      ]);

      const byStatus = (rows: Array<{ status: string; _count: { _all: number } }>) =>
        Object.fromEntries(rows.map((r) => [r.status, r._count._all])) as Record<
          string,
          number
        >;

      const conn = byStatus(connectionGroups);
      const sess = byStatus(sessionGroups);
      const evt = byStatus(eventGroups);

      const connections = {
        connected: conn.connected ?? 0,
        reconnectRequired: conn.reconnect_required ?? 0,
        revoked: conn.revoked ?? 0,
        expired: conn.expired ?? 0,
        error: conn.error ?? 0,
        notConnected: conn.not_connected ?? 0,
        // An academy with no connection row at all has never started.
        notInstalled: Math.max(academyCount - connectionCount, 0),
      };

      const sessions = {
        live: sess.live ?? 0,
        upcoming: sess.scheduled ?? 0,
        ended: sess.ended ?? 0,
        cancelled: sess.cancelled ?? 0,
        failed: sess.failed ?? 0,
        unprovisioned,
      };

      /*
        NEEDS ATTENTION is a projection of the counts above, not a second
        source of truth. Zero-count rows are dropped so the list shows
        real work rather than a wall of green.
      */
      const needsAttention: ZoomAttentionItem[] = [
        {
          kind: 'connection.revoked',
          severity: 'critical' as const,
          count: connections.revoked,
        },
        {
          kind: 'connection.reconnect_required',
          severity: 'critical' as const,
          count: connections.reconnectRequired,
        },
        {
          kind: 'connection.expired',
          severity: 'warning' as const,
          count: connections.expired,
        },
        {
          kind: 'connection.error',
          severity: 'warning' as const,
          count: connections.error,
        },
        { kind: 'session.failed', severity: 'critical' as const, count: sessions.failed },
        {
          kind: 'session.unprovisioned',
          severity: 'warning' as const,
          count: sessions.unprovisioned,
        },
        { kind: 'event.failed', severity: 'warning' as const, count: evt.failed ?? 0 },
        { kind: 'event.unmatched', severity: 'info' as const, count: evt.unmatched ?? 0 },
      ].filter((item) => item.count > 0);

      return {
        connections,
        sessions,
        events: {
          received: evt.received ?? 0,
          processed: evt.processed ?? 0,
          unmatched: evt.unmatched ?? 0,
          failed: evt.failed ?? 0,
        },
        needsAttention,
        upcomingAtRisk: atRiskRows.map(toSessionRow),
        recentActivity: activityRows.map((row): ZoomActivityRow => ({
          id: row.id,
          action: row.action,
          academyId: row.academyId ?? undefined,
          organizationId: row.organizationId ?? undefined,
          actorName: row.actor?.name ?? undefined,
          occurredAt: row.occurredAt.toISOString(),
        })),
      };
    });
  }

  /**
   * Connections, listed from ACADEMIES rather than from connection rows.
   *
   * An academy that has never connected has no connection row at all, and
   * "which academies are not using Zoom" is one of the questions this page
   * exists to answer — so basing the list on connections would hide
   * exactly the rows an operator is looking for.
   */
  async listConnections(
    platformOwnerId: string,
    query: PlatformZoomConnectionsQueryDto,
  ): Promise<PaginatedResult<ZoomConnectionRow>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    return this.asPlatformOwner(platformOwnerId, async (tx) => {
      const where: Prisma.AcademyWhereInput = {
        ...(query.organizationId ? { organizationId: query.organizationId } : {}),
        ...(query.academyId ? { id: query.academyId } : {}),
        ...(query.search
          ? {
              OR: [
                { name: { contains: query.search, mode: 'insensitive' as const } },
                {
                  organization: {
                    name: { contains: query.search, mode: 'insensitive' as const },
                  },
                },
              ],
            }
          : {}),
        ...(query.status
          ? query.status === 'not_connected'
            ? {
                OR: [
                  { liveProviderConnection: { is: null } },
                  { liveProviderConnection: { status: 'not_connected' } },
                ],
              }
            : { liveProviderConnection: { status: query.status } }
          : {}),
        ...(query.issuesOnly
          ? { liveProviderConnection: { status: { in: ISSUE_STATUS_FILTER() } } }
          : {}),
      };

      const [rows, totalItems] = await Promise.all([
        tx.academy.findMany({
          where,
          orderBy: { name: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            name: true,
            organizationId: true,
            organization: {
              select: {
                name: true,
                // One bounded include, not a per-row query: whether the
                // Live Sessions add-on is live for this organization.
                addOns: {
                  where: { addOn: { key: 'live-sessions' } },
                  select: { status: true },
                  take: 1,
                },
              },
            },
            liveProviderConnection: {
              select: {
                status: true,
                externalAccountId: true,
                connectedAt: true,
                lastCheckedAt: true,
                lastCheckResult: true,
                updatedAt: true,
              },
            },
          },
        }),
        tx.academy.count({ where }),
      ]);

      const items = rows.map((academy): ZoomConnectionRow => {
        const connection = academy.liveProviderConnection;
        const status = (connection?.status ?? 'not_connected') as ZoomConnectionStatus;
        const addOnStatus = academy.organization.addOns[0]?.status;
        const check = connection?.lastCheckResult as
          { reason?: string } | null | undefined;

        return {
          academyId: academy.id,
          academyName: academy.name,
          organizationId: academy.organizationId,
          organizationName: academy.organization.name,
          addOnInstalled: addOnStatus === 'enabled' || addOnStatus === 'installed',
          status,
          // Masked here, at the boundary — the full id never leaves the service.
          maskedAccountId: maskAccountId(connection?.externalAccountId),
          connectedAt: connection?.connectedAt?.toISOString(),
          lastCheckedAt: connection?.lastCheckedAt?.toISOString(),
          lastCheckReason: typeof check?.reason === 'string' ? check.reason : undefined,
          lastEventAt: connection?.updatedAt?.toISOString(),
          hasIssue: isIssueStatus(status),
        };
      });

      return { items, pagination: buildPaginationMeta(page, pageSize, totalItems) };
    });
  }

  async listSessions(
    platformOwnerId: string,
    query: PlatformZoomSessionsQueryDto,
  ): Promise<PaginatedResult<ZoomLiveSessionRow>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const now = new Date();

    return this.asPlatformOwner(platformOwnerId, async (tx) => {
      const where: Prisma.LiveSessionWhereInput = {
        ...(query.academyId ? { academyId: query.academyId } : {}),
        ...(query.organizationId
          ? { academy: { organizationId: query.organizationId } }
          : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.search
          ? { title: { contains: query.search, mode: 'insensitive' as const } }
          : {}),
        ...(query.from || query.to
          ? {
              scheduledStartAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
        ...(query.atRiskOnly
          ? {
              status: { in: ['scheduled', 'live'] },
              scheduledStartAt: { gte: now },
              OR: [
                { providerMeetingId: null },
                {
                  academy: {
                    liveProviderConnection: { status: { in: ISSUE_STATUS_FILTER() } },
                  },
                },
                { academy: { liveProviderConnection: { is: null } } },
              ],
            }
          : {}),
      };

      const [rows, totalItems] = await Promise.all([
        tx.liveSession.findMany({
          where,
          orderBy: { scheduledStartAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: SESSION_SELECT,
        }),
        tx.liveSession.count({ where }),
      ]);

      return {
        items: rows.map(toSessionRow),
        pagination: buildPaginationMeta(page, pageSize, totalItems),
      };
    });
  }

  /**
   * Attendance through the reconciliation lens.
   *
   * The state is DERIVED from stored fields, never a new column:
   *   reconciled  -> attendanceReconciledAt is set
   *   pending     -> ended, not yet reconciled, still within attempt budget
   *   failing     -> ended, not reconciled, attempts exhausted
   *   not_due     -> has not ended yet
   * Filtering by state is translated into the equivalent stored-field
   * predicate so paging stays in the database.
   */
  async listAttendance(
    platformOwnerId: string,
    query: PlatformZoomAttendanceQueryDto,
  ): Promise<PaginatedResult<ZoomAttendanceRow>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    return this.asPlatformOwner(platformOwnerId, async (tx) => {
      const stateWhere = this.attendanceStateWhere(query.state);
      const where: Prisma.LiveSessionWhereInput = {
        ...(query.academyId ? { academyId: query.academyId } : {}),
        ...(query.organizationId
          ? { academy: { organizationId: query.organizationId } }
          : {}),
        ...stateWhere,
      };

      const [rows, totalItems] = await Promise.all([
        tx.liveSession.findMany({
          where,
          orderBy: { scheduledStartAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            title: true,
            status: true,
            scheduledStartAt: true,
            endedAt: true,
            attendanceReconciledAt: true,
            reconciliationAttempts: true,
            academy: { select: { name: true, organization: { select: { name: true } } } },
            course: { select: { title: true } },
            // A count, not the rows — never loads participants into memory.
            _count: { select: { participants: true } },
          },
        }),
        tx.liveSession.count({ where }),
      ]);

      const items = rows.map((r): ZoomAttendanceRow => ({
        sessionId: r.id,
        title: r.title,
        academyName: r.academy.name,
        organizationName: r.academy.organization.name,
        courseTitle: r.course?.title,
        status: r.status,
        scheduledStartAt: r.scheduledStartAt.toISOString(),
        endedAt: r.endedAt?.toISOString(),
        reconciledAt: r.attendanceReconciledAt?.toISOString(),
        reconciliationAttempts: r.reconciliationAttempts,
        participantCount: r._count.participants,
        reconciliationState: this.reconciliationState(
          r.status,
          r.attendanceReconciledAt,
          r.reconciliationAttempts,
        ),
      }));

      return { items, pagination: buildPaginationMeta(page, pageSize, totalItems) };
    });
  }

  /** The stored-field predicate equivalent to each derived state. */
  private attendanceStateWhere(
    state: PlatformZoomAttendanceQueryDto['state'],
  ): Prisma.LiveSessionWhereInput {
    switch (state) {
      case 'reconciled':
        return { attendanceReconciledAt: { not: null } };
      case 'pending':
        return {
          status: 'ended',
          attendanceReconciledAt: null,
          reconciliationAttempts: { lt: MAX_RECONCILIATION_ATTEMPTS },
        };
      case 'failing':
        return {
          status: 'ended',
          attendanceReconciledAt: null,
          reconciliationAttempts: { gte: MAX_RECONCILIATION_ATTEMPTS },
        };
      case 'not_due':
        return { status: { notIn: ['ended'] }, attendanceReconciledAt: null };
      default:
        return {};
    }
  }

  private reconciliationState(
    status: string,
    reconciledAt: Date | null,
    attempts: number,
  ): ZoomAttendanceRow['reconciliationState'] {
    if (reconciledAt) return 'reconciled';
    if (status !== 'ended') return 'not_due';
    return attempts >= MAX_RECONCILIATION_ATTEMPTS ? 'failing' : 'pending';
  }

  /** Recording lifecycle across every academy — from LiveSessionRecording. */
  async listRecordings(
    platformOwnerId: string,
    query: PlatformZoomRecordingsQueryDto,
  ): Promise<PaginatedResult<ZoomRecordingRow>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    return this.asPlatformOwner(platformOwnerId, async (tx) => {
      const where: Prisma.LiveSessionRecordingWhereInput = {
        ...(query.academyId ? { academyId: query.academyId } : {}),
        ...(query.organizationId ? { organizationId: query.organizationId } : {}),
        ...(query.status ? { status: query.status } : {}),
      };

      const [rows, totalItems] = await Promise.all([
        tx.liveSessionRecording.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            status: true,
            quotaConsumedAt: true,
            failureReason: true,
            createdAt: true,
            availableAt: true,
            liveSession: {
              select: {
                id: true,
                title: true,
                academy: {
                  select: { name: true, organization: { select: { name: true } } },
                },
              },
            },
            _count: { select: { files: true } },
          },
        }),
        tx.liveSessionRecording.count({ where }),
      ]);

      const items = rows.map((r): ZoomRecordingRow => ({
        recordingId: r.id,
        sessionId: r.liveSession.id,
        title: r.liveSession.title,
        academyName: r.liveSession.academy.name,
        organizationName: r.liveSession.academy.organization.name,
        status: r.status,
        fileCount: r._count.files,
        // One session consumes one quota unit — the flag is the stored
        // quotaConsumedAt, NOT a count of files.
        quotaConsumed: r.quotaConsumedAt !== null,
        failureReason: r.failureReason ?? undefined,
        createdAt: r.createdAt.toISOString(),
        availableAt: r.availableAt?.toISOString(),
      }));

      return { items, pagination: buildPaginationMeta(page, pageSize, totalItems) };
    });
  }

  /** Provider events, plus health counts, from live_provider_events. */
  async listEvents(
    platformOwnerId: string,
    query: PlatformZoomEventsQueryDto,
  ): Promise<PaginatedResult<ZoomEventRow> & { health: ZoomEventHealth }> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    return this.asPlatformOwner(platformOwnerId, async (tx) => {
      const where: Prisma.LiveProviderEventWhereInput = {
        providerKey: 'zoom',
        ...(query.academyId ? { academyId: query.academyId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.eventType ? { eventType: query.eventType } : {}),
      };

      const [rows, totalItems, statusGroups, typeGroups] = await Promise.all([
        tx.liveProviderEvent.findMany({
          where,
          orderBy: { receivedAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            eventType: true,
            status: true,
            failureReason: true,
            receivedAt: true,
            processedAt: true,
            academyId: true,
            liveSessionId: true,
          },
        }),
        tx.liveProviderEvent.count({ where }),
        tx.liveProviderEvent.groupBy({
          by: ['status'],
          where: { providerKey: 'zoom' },
          _count: { _all: true },
        }),
        tx.liveProviderEvent.groupBy({
          by: ['eventType'],
          where: { providerKey: 'zoom' },
          _count: { _all: true },
        }),
      ]);

      // Resolve academy/session labels for the page's rows in ONE query
      // each, not per row.
      const academyIds = [
        ...new Set(rows.map((r) => r.academyId).filter((x): x is string => !!x)),
      ];
      const sessionIds = [
        ...new Set(rows.map((r) => r.liveSessionId).filter((x): x is string => !!x)),
      ];
      const [academies, sessions] = await Promise.all([
        academyIds.length
          ? tx.academy.findMany({
              where: { id: { in: academyIds } },
              select: { id: true, name: true },
            })
          : Promise.resolve([]),
        sessionIds.length
          ? tx.liveSession.findMany({
              where: { id: { in: sessionIds } },
              select: { id: true, title: true },
            })
          : Promise.resolve([]),
      ]);
      const academyName = new Map(academies.map((a) => [a.id, a.name]));
      const sessionTitle = new Map(sessions.map((sn) => [sn.id, sn.title]));

      const byStatus = Object.fromEntries(
        statusGroups.map((g) => [g.status, g._count._all]),
      ) as Record<string, number>;

      const items = rows.map((r): ZoomEventRow => ({
        id: r.id,
        eventType: r.eventType,
        status: r.status,
        academyName: r.academyId ? academyName.get(r.academyId) : undefined,
        sessionTitle: r.liveSessionId ? sessionTitle.get(r.liveSessionId) : undefined,
        failureReason: r.failureReason ?? undefined,
        receivedAt: r.receivedAt.toISOString(),
        processedAt: r.processedAt?.toISOString(),
      }));

      const health: ZoomEventHealth = {
        received: byStatus.received ?? 0,
        processed: byStatus.processed ?? 0,
        unmatched: byStatus.unmatched ?? 0,
        failed: byStatus.failed ?? 0,
        byType: typeGroups
          .map((g) => ({ eventType: g.eventType, count: g._count._all }))
          .sort((a, b) => b.count - a.count),
      };

      return {
        items,
        pagination: buildPaginationMeta(page, pageSize, totalItems),
        health,
      };
    });
  }

  /**
   * Health & Incidents — active operational conditions grouped by kind,
   * each with a few sample academies for triage.
   *
   * These are CURRENT conditions derived from live state, not a new
   * incident-lifecycle table. There is no resolution workflow because the
   * data does not model one; an issue disappears when the underlying state
   * changes.
   */
  async getHealth(platformOwnerId: string): Promise<ZoomHealthResponse> {
    const now = new Date();
    const horizon = new Date(now.getTime() + AT_RISK_WINDOW_MS);

    return this.asPlatformOwner(platformOwnerId, async (tx) => {
      const sampleAcademies = async (where: Prisma.AcademyWhereInput) =>
        (
          await tx.academy.findMany({ where, select: { id: true, name: true }, take: 5 })
        ).map((a) => ({ academyId: a.id, academyName: a.name }));

      const connectionIssue = (status: LiveProviderConnectionStatus) => ({
        where: { liveProviderConnection: { status } } as Prisma.AcademyWhereInput,
      });

      const groups: ZoomHealthIssueGroup[] = [];

      const push = async (
        kind: string,
        severity: ZoomHealthIssueGroup['severity'],
        count: number,
        where: Prisma.AcademyWhereInput,
      ) => {
        if (count > 0)
          groups.push({ kind, severity, count, samples: await sampleAcademies(where) });
      };

      const [revoked, reconnect, expired, errored] = await Promise.all([
        tx.academyLiveProviderConnection.count({
          where: { providerKey: 'zoom', status: 'revoked' },
        }),
        tx.academyLiveProviderConnection.count({
          where: { providerKey: 'zoom', status: 'reconnect_required' },
        }),
        tx.academyLiveProviderConnection.count({
          where: { providerKey: 'zoom', status: 'expired' },
        }),
        tx.academyLiveProviderConnection.count({
          where: { providerKey: 'zoom', status: 'error' },
        }),
      ]);
      await push(
        'connection.revoked',
        'critical',
        revoked,
        connectionIssue('revoked').where,
      );
      await push(
        'connection.reconnect_required',
        'critical',
        reconnect,
        connectionIssue('reconnect_required').where,
      );
      await push(
        'connection.expired',
        'warning',
        expired,
        connectionIssue('expired').where,
      );
      await push('connection.error', 'warning', errored, connectionIssue('error').where);

      const failedSessions = await tx.liveSession.count({ where: { status: 'failed' } });
      if (failedSessions > 0) {
        groups.push({
          kind: 'session.failed',
          severity: 'critical',
          count: failedSessions,
          samples: (
            await tx.liveSession.findMany({
              where: { status: 'failed' },
              select: { academyId: true, academy: { select: { name: true } } },
              distinct: ['academyId'],
              take: 5,
            })
          ).map((r) => ({ academyId: r.academyId, academyName: r.academy.name })),
        });
      }

      const atRiskWhere: Prisma.LiveSessionWhereInput = {
        status: { in: ['scheduled', 'live'] },
        scheduledStartAt: { gte: now, lte: horizon },
        OR: [
          { providerMeetingId: null },
          {
            academy: {
              liveProviderConnection: { status: { in: ISSUE_STATUS_FILTER() } },
            },
          },
          { academy: { liveProviderConnection: { is: null } } },
        ],
      };
      const atRisk = await tx.liveSession.count({ where: atRiskWhere });
      if (atRisk > 0) {
        groups.push({
          kind: 'session.at_risk',
          severity: 'warning',
          count: atRisk,
          samples: (
            await tx.liveSession.findMany({
              where: atRiskWhere,
              select: { academyId: true, academy: { select: { name: true } } },
              distinct: ['academyId'],
              take: 5,
            })
          ).map((r) => ({ academyId: r.academyId, academyName: r.academy.name })),
        });
      }

      const failedEvents = await tx.liveProviderEvent.count({
        where: { providerKey: 'zoom', status: 'failed' },
      });
      if (failedEvents > 0) {
        groups.push({
          kind: 'event.failed',
          severity: 'warning',
          count: failedEvents,
          samples: [],
        });
      }

      // Ordered: critical first, then by size.
      const rank = { critical: 0, warning: 1, info: 2 } as const;
      groups.sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count);
      return { groups };
    });
  }

  /**
   * Chronological Zoom integration activity — the five audit actions the
   * integration actually writes. No invented events.
   */
  async listActivity(
    platformOwnerId: string,
    query: PlatformZoomActivityQueryDto,
  ): Promise<PaginatedResult<ZoomActivityRow>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    return this.asPlatformOwner(platformOwnerId, async (tx) => {
      const where: Prisma.AuditLogEntryWhereInput = {
        action:
          query.action && ZOOM_AUDIT_ACTIONS.includes(query.action)
            ? query.action
            : { in: [...ZOOM_AUDIT_ACTIONS] },
        ...(query.academyId ? { academyId: query.academyId } : {}),
        ...(query.organizationId ? { organizationId: query.organizationId } : {}),
      };

      const [rows, totalItems] = await Promise.all([
        tx.auditLogEntry.findMany({
          where,
          orderBy: { occurredAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            action: true,
            academyId: true,
            organizationId: true,
            occurredAt: true,
            actor: { select: { name: true } },
          },
        }),
        tx.auditLogEntry.count({ where }),
      ]);

      const items = rows.map((r): ZoomActivityRow => ({
        id: r.id,
        action: r.action,
        academyId: r.academyId ?? undefined,
        organizationId: r.organizationId ?? undefined,
        actorName: r.actor?.name ?? undefined,
        occurredAt: r.occurredAt.toISOString(),
      }));

      return { items, pagination: buildPaginationMeta(page, pageSize, totalItems) };
    });
  }

  /**
   * Everything about one academy's Zoom integration, on one screen.
   *
   * Bounded: a handful of grouped counts, the entitlement-backed quota
   * (one call to the real RecordingQuotaService), and two short capped
   * lists. No per-row follow-up queries.
   */
  async getAcademyDetail(
    platformOwnerId: string,
    academyId: string,
  ): Promise<ZoomAcademyDetail | null> {
    const now = new Date();
    const horizon = new Date(now.getTime() + AT_RISK_WINDOW_MS);

    const detail = await this.asPlatformOwner(platformOwnerId, async (tx) => {
      const academy = await tx.academy.findUnique({
        where: { id: academyId },
        select: {
          id: true,
          name: true,
          organizationId: true,
          organization: {
            select: {
              name: true,
              addOns: {
                where: { addOn: { key: 'live-sessions' } },
                select: { status: true },
                take: 1,
              },
            },
          },
          liveProviderConnection: {
            select: {
              status: true,
              externalAccountId: true,
              connectedAt: true,
              lastCheckedAt: true,
              lastCheckResult: true,
            },
          },
        },
      });
      if (!academy) return null;

      const [sessionGroups, reconciled, pending, recGroups, atRiskRows, activityRows] =
        await Promise.all([
          tx.liveSession.groupBy({
            by: ['status'],
            where: { academyId },
            _count: { _all: true },
          }),
          tx.liveSession.count({
            where: { academyId, attendanceReconciledAt: { not: null } },
          }),
          tx.liveSession.count({
            where: { academyId, status: 'ended', attendanceReconciledAt: null },
          }),
          tx.liveSessionRecording.groupBy({
            by: ['status'],
            where: { academyId },
            _count: { _all: true },
          }),
          tx.liveSession.findMany({
            where: {
              academyId,
              status: { in: ['scheduled', 'live'] },
              scheduledStartAt: { gte: now, lte: horizon },
              OR: [
                { providerMeetingId: null },
                {
                  academy: {
                    liveProviderConnection: { status: { in: ISSUE_STATUS_FILTER() } },
                  },
                },
                { academy: { liveProviderConnection: { is: null } } },
              ],
            },
            orderBy: { scheduledStartAt: 'asc' },
            take: 10,
            select: SESSION_SELECT,
          }),
          tx.auditLogEntry.findMany({
            where: { academyId, action: { in: [...ZOOM_AUDIT_ACTIONS] } },
            orderBy: { occurredAt: 'desc' },
            take: 10,
            select: {
              id: true,
              action: true,
              academyId: true,
              organizationId: true,
              occurredAt: true,
              actor: { select: { name: true } },
            },
          }),
        ]);

      const sess = Object.fromEntries(
        sessionGroups.map((g) => [g.status, g._count._all]),
      ) as Record<string, number>;
      const rec = Object.fromEntries(
        recGroups.map((g) => [g.status, g._count._all]),
      ) as Record<string, number>;
      const conn = academy.liveProviderConnection;
      const check = conn?.lastCheckResult as { reason?: string } | null | undefined;
      const addOnStatus = academy.organization.addOns[0]?.status;

      return {
        academy,
        organizationId: academy.organizationId,
        addOnInstalled: addOnStatus === 'enabled' || addOnStatus === 'installed',
        connection: {
          status: (conn?.status ?? 'not_connected') as ZoomConnectionStatus,
          maskedAccountId: maskAccountId(conn?.externalAccountId),
          connectedAt: conn?.connectedAt?.toISOString(),
          lastCheckedAt: conn?.lastCheckedAt?.toISOString(),
          lastCheckReason: typeof check?.reason === 'string' ? check.reason : undefined,
        },
        sessions: {
          upcoming: sess.scheduled ?? 0,
          live: sess.live ?? 0,
          ended: sess.ended ?? 0,
          failed: sess.failed ?? 0,
          atRisk: atRiskRows.length,
        },
        attendance: { reconciled, pending },
        recordings: {
          available: rec.available ?? 0,
          processing: rec.processing ?? 0,
          failed: rec.failed ?? 0,
        },
        upcomingAtRisk: atRiskRows.map(toSessionRow),
        recentActivity: activityRows.map((r) => ({
          id: r.id,
          action: r.action,
          academyId: r.academyId ?? undefined,
          organizationId: r.organizationId ?? undefined,
          actorName: r.actor?.name ?? undefined,
          occurredAt: r.occurredAt.toISOString(),
        })),
        organizationName: academy.organization.name,
      };
    });

    if (!detail) return null;

    // The entitlement-backed quota — a real call to the same service the
    // product uses, in the resolved tenant's context (its own RLS).
    const quota = await this.tenancyContextService.runInTenantContext(
      detail.organizationId,
      (tx) => this.recordingQuotaService.describeUsage(tx, detail.organizationId),
    );

    return {
      academyId: detail.academy.id,
      academyName: detail.academy.name,
      organizationId: detail.organizationId,
      organizationName: detail.organizationName,
      addOnInstalled: detail.addOnInstalled,
      connection: detail.connection,
      sessions: detail.sessions,
      attendance: detail.attendance,
      recordings: {
        ...detail.recordings,
        quotaUsed: quota.used,
        quotaLimit: quota.limit,
        quotaRemaining: quota.remaining,
      },
      upcomingAtRisk: detail.upcomingAtRisk,
      recentActivity: detail.recentActivity,
    };
  }
}
