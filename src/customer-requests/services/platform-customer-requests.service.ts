/**
 * Customer Requests — the Platform Owner console: every request, its full
 * history (internal notes included), triage, assignment, replies, and the
 * request-type → team-inbox routing table.
 *
 * Runs in the Platform Owner's own user context: every table's
 * `*_platform_*` policy re-checks `is_platform_owner` underneath the guard.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CustomerRequestStatus, CustomerRequestType, Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CommunicationService } from '../../communications/services/communication.service';
import {
  buildPaginationMeta,
  type PaginatedResult,
} from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import {
  CLOSED_STATUSES,
  CUSTOMER_REQUEST_STATUSES,
  CUSTOMER_REQUEST_TYPES,
  TEAM_TRANSITIONS,
} from '../customer-requests.constants';
import type { ListPlatformCustomerRequestsQueryDto } from '../dto/list-customer-requests-query.dto';
import type { UpdateCustomerRequestDto } from '../dto/update-customer-request.dto';
import type { RoutingRuleDto } from '../dto/routing-rules.dto';
import type {
  CustomerRequestCountsResponse,
  PlatformCustomerRequestDetailResponse,
  PlatformCustomerRequestSummaryResponse,
  PlatformOwnerOptionResponse,
  RoutingRuleResponse,
} from '../dto/customer-request.contract';
import {
  canTeamMove,
  excerpt,
  isClosed,
  toEventResponse,
  toSummary,
} from '../customer-request.mapper';

const INCLUDE = {
  academy: { select: { id: true, name: true } },
  organization: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
} as const;

type RequestRow = Prisma.CustomerRequestGetPayload<{ include: typeof INCLUDE }>;

function toPlatformSummary(row: RequestRow): PlatformCustomerRequestSummaryResponse {
  return {
    ...toSummary(row),
    organization: { id: row.organization.id, name: row.organization.name },
    assignee: row.assignedTo
      ? { id: row.assignedTo.id, name: row.assignedTo.name }
      : null,
  };
}

@Injectable()
export class PlatformCustomerRequestsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly communicationService: CommunicationService,
  ) {}

  private run<T>(ownerId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.tenancyContextService.runInUserContext(ownerId, work);
  }

  async list(
    ownerId: string,
    query: ListPlatformCustomerRequestsQueryDto,
  ): Promise<PaginatedResult<PlatformCustomerRequestSummaryResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const search = query.search?.trim();
    const where: Prisma.CustomerRequestWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.status === 'open'
        ? { status: { notIn: [...CLOSED_STATUSES] } }
        : query.status
          ? { status: query.status }
          : {}),
      ...(query.academyId ? { academyId: query.academyId } : {}),
      ...(query.assigneeUserId === 'unassigned'
        ? { assignedToUserId: null }
        : query.assigneeUserId
          ? { assignedToUserId: query.assigneeUserId }
          : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { requesterName: { contains: search, mode: 'insensitive' } },
              { requesterEmail: { contains: search, mode: 'insensitive' } },
              { academy: { name: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    return this.run(ownerId, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.customerRequest.findMany({
          where,
          include: INCLUDE,
          orderBy: { [query.sortBy ?? 'lastActivityAt']: query.sortDirection ?? 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.customerRequest.count({ where }),
      ]);
      return {
        items: rows.map(toPlatformSummary),
        pagination: buildPaginationMeta(page, pageSize, total),
      };
    });
  }

  async counts(ownerId: string): Promise<CustomerRequestCountsResponse> {
    return this.run(ownerId, async (tx) => {
      const grouped = await tx.customerRequest.groupBy({
        by: ['status'],
        _count: { _all: true },
      });
      const byStatus = Object.fromEntries(
        CUSTOMER_REQUEST_STATUSES.map((status) => [status, 0]),
      ) as Record<CustomerRequestStatus, number>;
      for (const row of grouped) byStatus[row.status] = row._count._all;
      const open = CUSTOMER_REQUEST_STATUSES.filter(
        (s) => !CLOSED_STATUSES.has(s),
      ).reduce((sum, status) => sum + byStatus[status], 0);
      return { open, byStatus };
    });
  }

  async get(
    ownerId: string,
    requestId: string,
  ): Promise<PlatformCustomerRequestDetailResponse> {
    return this.run(ownerId, (tx) => this.detail(tx, requestId));
  }

  async update(
    ownerId: string,
    requestId: string,
    payload: UpdateCustomerRequestDto,
  ): Promise<PlatformCustomerRequestDetailResponse> {
    if (payload.status === undefined && payload.assigneeUserId === undefined) {
      throw new BadRequestException({
        messageKey: 'errors.customerRequest.nothingToUpdate',
      });
    }
    const outboxIds = await this.run(ownerId, async (tx) => {
      const request = await this.lock(tx, requestId);
      const ownerName = await this.userName(tx, ownerId);
      const now = new Date();
      const ids: (string | null)[] = [];

      if (
        payload.assigneeUserId !== undefined &&
        payload.assigneeUserId !== request.assignedToUserId
      ) {
        if (payload.assigneeUserId !== null)
          await this.assertPlatformOwner(tx, payload.assigneeUserId);
        await tx.customerRequest.update({
          where: { id: requestId },
          data: { assignedToUserId: payload.assigneeUserId, lastActivityAt: now },
        });
        await tx.customerRequestEvent.create({
          data: {
            requestId,
            organizationId: request.organizationId,
            kind: 'assigned',
            visibility: 'internal',
            actorUserId: ownerId,
            actorName: ownerName,
            actorSide: 'team',
            assigneeUserId: payload.assigneeUserId,
          },
        });
        await this.auditLogWriterService.write(tx, {
          actorUserId: ownerId,
          organizationId: request.organizationId,
          academyId: request.academyId,
          role: 'platform_owner',
          action: 'customer_request.assigned',
          targetType: 'customer_request',
          targetId: requestId,
          targetLabel: request.title,
          context: {
            assigneeUserId: payload.assigneeUserId,
            previousAssigneeUserId: request.assignedToUserId,
          },
        });
      }

      if (payload.status !== undefined && payload.status !== request.status) {
        if (!canTeamMove(request.status, payload.status)) {
          throw new ConflictException({
            messageKey: 'errors.customerRequest.invalidTransition',
            details: { from: request.status, to: payload.status },
          });
        }
        await tx.customerRequest.update({
          where: { id: requestId },
          data: {
            status: payload.status,
            lastActivityAt: now,
            closedAt: CLOSED_STATUSES.has(payload.status) ? now : null,
          },
        });
        const event = await tx.customerRequestEvent.create({
          data: {
            requestId,
            organizationId: request.organizationId,
            kind: 'status_changed',
            visibility: 'customer',
            actorUserId: ownerId,
            actorName: ownerName,
            actorSide: 'team',
            fromStatus: request.status,
            toStatus: payload.status,
          },
        });
        await this.auditLogWriterService.write(tx, {
          actorUserId: ownerId,
          organizationId: request.organizationId,
          academyId: request.academyId,
          role: 'platform_owner',
          action: 'customer_request.status_changed',
          targetType: 'customer_request',
          targetId: requestId,
          targetLabel: request.title,
          context: { fromStatus: request.status, toStatus: payload.status },
        });
        if (request.requesterUserId) {
          const emitted = await this.communicationService.emit(tx, {
            key: 'customer_request.status_changed',
            recipientUserId: request.requesterUserId,
            organizationId: request.organizationId,
            academyId: request.academyId,
            entity: { type: 'customer_request', id: requestId },
            values: {
              eventId: event.id,
              title: request.title,
              status: payload.status,
              academyId: request.academyId,
            },
          });
          ids.push(emitted.outboxId);
        }
      }

      const note = payload.note?.trim();
      if (note) {
        ids.push(
          ...(await this.postMessage(tx, ownerId, ownerName, request, note, false)),
        );
      }
      return ids;
    });
    for (const outboxId of outboxIds)
      await this.communicationService.enqueueAfterCommit(outboxId);
    return this.get(ownerId, requestId);
  }

  async message(
    ownerId: string,
    requestId: string,
    body: string,
    internal: boolean,
  ): Promise<PlatformCustomerRequestDetailResponse> {
    const outboxIds = await this.run(ownerId, async (tx) => {
      const request = await this.lock(tx, requestId);
      // A note to the team is always possible; a message to a customer
      // whose request is closed would arrive on a dead thread.
      if (!internal && isClosed(request.status)) {
        throw new ConflictException({ messageKey: 'errors.customerRequest.closed' });
      }
      return this.postMessage(
        tx,
        ownerId,
        await this.userName(tx, ownerId),
        request,
        body,
        internal,
      );
    });
    for (const outboxId of outboxIds)
      await this.communicationService.enqueueAfterCommit(outboxId);
    return this.get(ownerId, requestId);
  }

  async owners(ownerId: string): Promise<PlatformOwnerOptionResponse[]> {
    return this.run(ownerId, async (tx) =>
      tx.user.findMany({
        where: { isPlatformOwner: true, status: 'active', deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    );
  }

  async routing(ownerId: string): Promise<RoutingRuleResponse[]> {
    return this.run(ownerId, async (tx) => {
      const rules = await tx.customerRequestRoutingRule.findMany();
      return CUSTOMER_REQUEST_TYPES.map((type) => {
        const rule = rules.find((candidate) => candidate.type === type);
        return {
          type,
          email: rule?.email ?? null,
          updatedAt: rule?.updatedAt.toISOString() ?? null,
        };
      });
    });
  }

  async updateRouting(
    ownerId: string,
    rules: readonly RoutingRuleDto[],
  ): Promise<RoutingRuleResponse[]> {
    const seen = new Set<CustomerRequestType>();
    for (const rule of rules) {
      if (seen.has(rule.type)) {
        throw new BadRequestException({
          messageKey: 'errors.customerRequest.duplicateRoutingType',
        });
      }
      seen.add(rule.type);
    }
    await this.run(ownerId, async (tx) => {
      for (const rule of rules) {
        const email = rule.email?.trim().toLowerCase();
        if (email) {
          await tx.customerRequestRoutingRule.upsert({
            where: { type: rule.type },
            create: { type: rule.type, email, updatedByUserId: ownerId },
            update: { email, updatedByUserId: ownerId },
          });
        } else {
          await tx.customerRequestRoutingRule.deleteMany({ where: { type: rule.type } });
        }
      }
      await this.auditLogWriterService.write(tx, {
        actorUserId: ownerId,
        role: 'platform_owner',
        action: 'customer_request.routing_updated',
        targetType: 'customer_request_routing',
        targetId: 'customer_request_routing',
        targetLabel: 'Customer request routing',
        // Which types changed — never the addresses themselves.
        context: { types: rules.map((rule) => rule.type).join(',') },
      });
    });
    return this.routing(ownerId);
  }

  private async postMessage(
    tx: Prisma.TransactionClient,
    ownerId: string,
    ownerName: string,
    request: {
      id: string;
      organizationId: string;
      academyId: string;
      title: string;
      requesterUserId: string | null;
    },
    body: string,
    internal: boolean,
  ): Promise<(string | null)[]> {
    const event = await tx.customerRequestEvent.create({
      data: {
        requestId: request.id,
        organizationId: request.organizationId,
        kind: internal ? 'internal_note' : 'team_message',
        visibility: internal ? 'internal' : 'customer',
        actorUserId: ownerId,
        actorName: ownerName,
        actorSide: 'team',
        body,
      },
    });
    await tx.customerRequest.update({
      where: { id: request.id },
      data: { lastActivityAt: new Date() },
    });
    await this.auditLogWriterService.write(tx, {
      actorUserId: ownerId,
      organizationId: request.organizationId,
      academyId: request.academyId,
      role: 'platform_owner',
      action: internal
        ? 'customer_request.internal_note_added'
        : 'customer_request.team_replied',
      targetType: 'customer_request',
      targetId: request.id,
      targetLabel: request.title,
    });
    if (internal || !request.requesterUserId) return [];
    const emitted = await this.communicationService.emit(tx, {
      key: 'customer_request.team_replied',
      recipientUserId: request.requesterUserId,
      organizationId: request.organizationId,
      academyId: request.academyId,
      entity: { type: 'customer_request', id: request.id },
      values: {
        eventId: event.id,
        title: request.title,
        excerpt: excerpt(body),
        academyId: request.academyId,
      },
    });
    return [emitted.outboxId];
  }

  private async detail(
    tx: Prisma.TransactionClient,
    requestId: string,
  ): Promise<PlatformCustomerRequestDetailResponse> {
    const request = await tx.customerRequest.findUnique({
      where: { id: requestId },
      include: INCLUDE,
    });
    if (!request) throw new NotFoundException({ messageKey: 'errors.notFound' });
    const events = await tx.customerRequestEvent.findMany({
      where: { requestId },
      orderBy: { createdAt: 'asc' },
    });
    const assigneeIds = [
      ...new Set(events.map((e) => e.assigneeUserId).filter((id): id is string => !!id)),
    ];
    const assignees = assigneeIds.length
      ? await tx.user.findMany({
          where: { id: { in: assigneeIds } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(assignees.map((user) => [user.id, user.name]));
    const rule = await tx.customerRequestRoutingRule.findUnique({
      where: { type: request.type },
    });
    const closed = isClosed(request.status);
    return {
      ...toPlatformSummary(request),
      description: request.description,
      details: (request.details ?? {}) as Record<string, string | boolean>,
      closedAt: request.closedAt?.toISOString() ?? null,
      events: events.map((event) =>
        toEventResponse(event, { includeVisibility: true, assigneeNames: names }),
      ),
      canCancel: false,
      canReply: !closed,
      requesterEmail: request.requesterEmail,
      allowedStatuses: TEAM_TRANSITIONS[request.status],
      routedTo: rule?.email ?? null,
    };
  }

  private async lock(tx: Prisma.TransactionClient, requestId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "customer_requests" WHERE "id" = ${requestId} FOR UPDATE
    `;
    if (rows.length === 0) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return tx.customerRequest.findUniqueOrThrow({ where: { id: requestId } });
  }

  private async assertPlatformOwner(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    const user = await tx.user.findFirst({
      where: { id: userId, isPlatformOwner: true, status: 'active', deletedAt: null },
      select: { id: true },
    });
    if (!user) {
      throw new BadRequestException({
        messageKey: 'errors.customerRequest.invalidAssignee',
      });
    }
  }

  private async userName(tx: Prisma.TransactionClient, userId: string): Promise<string> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    return user?.name ?? '';
  }
}
