/**
 * Customer Requests — the academy side: an owner/administrator files a
 * request, follows it, answers the team and may cancel it.
 *
 * Every read and write runs in the academy's tenant + the caller's user
 * context, so RLS holds the same line the route guard does: the
 * organization boundary for requests, and — independently of anything this
 * service does — `customer` visibility only for their history. Requests
 * are scoped to the academy in the route (a request id from another academy
 * of the same organization is 404, never 403).
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CustomerRequestStatus } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CommunicationService } from '../../communications/services/communication.service';
import {
  buildPaginationMeta,
  type PaginatedResult,
} from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import { CLOSED_STATUSES } from '../customer-requests.constants';
import type { CreateCustomerRequestDto } from '../dto/create-customer-request.dto';
import type { ListCustomerRequestsQueryDto } from '../dto/list-customer-requests-query.dto';
import type {
  CustomerRequestDetailResponse,
  CustomerRequestSummaryResponse,
} from '../dto/customer-request.contract';
import {
  isClosed,
  sanitizeDetails,
  toCustomerDetail,
  toSummary,
} from '../customer-request.mapper';
import { CustomerRequestNotifierService } from './customer-request-notifier.service';

export interface AcademyActor {
  readonly userId: string;
  readonly organizationId: string;
  readonly academyId: string;
  readonly role: string;
}

const ACADEMY_REF = { select: { id: true, name: true } } as const;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class CustomerRequestsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly communicationService: CommunicationService,
    private readonly notifier: CustomerRequestNotifierService,
  ) {}

  private run<T>(
    actor: AcademyActor,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.tenancyContextService.runInTenantAndUserContext(
      actor.organizationId,
      actor.userId,
      work,
    );
  }

  async create(
    actor: AcademyActor,
    payload: CreateCustomerRequestDto,
  ): Promise<CustomerRequestDetailResponse> {
    const details = sanitizeDetails(payload.type, payload.details);

    // A retried submit (same person, same client id) returns what it
    // already created — the click that timed out is not a second request.
    const existing = await this.findByClientId(actor, payload.clientRequestId);
    if (existing) return existing;

    let outboxId: string | null = null;
    let created: { requestId: string; eventId: string } | null = null;
    try {
      created = await this.run(actor, async (tx) => {
        const user = await tx.user.findUniqueOrThrow({
          where: { id: actor.userId },
          select: { name: true, email: true },
        });
        const request = await tx.customerRequest.create({
          data: {
            organizationId: actor.organizationId,
            academyId: actor.academyId,
            requesterUserId: actor.userId,
            requesterName: user.name,
            requesterEmail: user.email,
            type: payload.type,
            title: payload.title,
            description: payload.description,
            priority: payload.priority ?? 'normal',
            details,
            clientRequestId: payload.clientRequestId,
          },
        });
        const event = await tx.customerRequestEvent.create({
          data: {
            requestId: request.id,
            organizationId: actor.organizationId,
            kind: 'created',
            visibility: 'customer',
            actorUserId: actor.userId,
            actorName: user.name,
            actorSide: 'customer',
            toStatus: 'submitted',
          },
        });
        await this.auditLogWriterService.write(tx, {
          actorUserId: actor.userId,
          organizationId: actor.organizationId,
          academyId: actor.academyId,
          role: actor.role,
          action: 'customer_request.created',
          targetType: 'customer_request',
          targetId: request.id,
          targetLabel: request.title,
          context: { type: request.type, priority: request.priority },
        });
        const emitted = await this.communicationService.emit(tx, {
          key: 'customer_request.submitted',
          recipientUserId: actor.userId,
          organizationId: actor.organizationId,
          academyId: actor.academyId,
          entity: { type: 'customer_request', id: request.id },
          values: { title: request.title, type: request.type },
        });
        outboxId = emitted.outboxId;
        return { requestId: request.id, eventId: event.id };
      });
    } catch (error) {
      // Two simultaneous submits of the same form: the loser returns the winner.
      if (isUniqueViolation(error)) {
        const winner = await this.findByClientId(actor, payload.clientRequestId);
        if (winner) return winner;
      }
      throw error;
    }

    await this.communicationService.enqueueAfterCommit(outboxId);
    await this.notifier.notifyTeam({
      requestId: created.requestId,
      eventId: created.eventId,
      event: 'created',
      body: payload.description,
    });
    return this.get(actor, created.requestId);
  }

  async list(
    actor: AcademyActor,
    query: ListCustomerRequestsQueryDto,
  ): Promise<PaginatedResult<CustomerRequestSummaryResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.CustomerRequestWhereInput = {
      academyId: actor.academyId,
      ...(query.type ? { type: query.type } : {}),
      ...(query.status === 'open'
        ? { status: { notIn: [...CLOSED_STATUSES] } }
        : query.status
          ? { status: query.status }
          : {}),
      ...(query.search?.trim()
        ? { title: { contains: query.search.trim(), mode: 'insensitive' } }
        : {}),
    };
    return this.run(actor, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.customerRequest.findMany({
          where,
          include: { academy: ACADEMY_REF },
          orderBy: { [query.sortBy ?? 'lastActivityAt']: query.sortDirection ?? 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.customerRequest.count({ where }),
      ]);
      return {
        items: rows.map(toSummary),
        pagination: buildPaginationMeta(page, pageSize, total),
      };
    });
  }

  async get(
    actor: AcademyActor,
    requestId: string,
  ): Promise<CustomerRequestDetailResponse> {
    return this.run(actor, async (tx) => {
      const request = await tx.customerRequest.findFirst({
        where: { id: requestId, academyId: actor.academyId },
        include: { academy: ACADEMY_REF },
      });
      if (!request) throw new NotFoundException({ messageKey: 'errors.notFound' });
      // `visibility: 'customer'` here AND in RLS — two independent locks.
      const events = await tx.customerRequestEvent.findMany({
        where: { requestId, visibility: 'customer' },
        orderBy: { createdAt: 'asc' },
      });
      return toCustomerDetail(request, events);
    });
  }

  async cancel(
    actor: AcademyActor,
    requestId: string,
  ): Promise<CustomerRequestDetailResponse> {
    await this.run(actor, async (tx) => {
      const request = await this.lockOwn(tx, actor, requestId);
      if (isClosed(request.status)) {
        throw new ConflictException({ messageKey: 'errors.customerRequest.closed' });
      }
      const actorName = await this.actorName(tx, actor.userId);
      const now = new Date();
      await tx.customerRequest.update({
        where: { id: requestId },
        data: { status: 'cancelled', closedAt: now, lastActivityAt: now },
      });
      await tx.customerRequestEvent.create({
        data: {
          requestId,
          organizationId: actor.organizationId,
          kind: 'status_changed',
          visibility: 'customer',
          actorUserId: actor.userId,
          actorName,
          actorSide: 'customer',
          fromStatus: request.status,
          toStatus: 'cancelled',
        },
      });
      await this.auditLogWriterService.write(tx, {
        actorUserId: actor.userId,
        organizationId: actor.organizationId,
        academyId: actor.academyId,
        role: actor.role,
        action: 'customer_request.cancelled',
        targetType: 'customer_request',
        targetId: requestId,
        targetLabel: request.title,
        context: { fromStatus: request.status },
      });
    });
    return this.get(actor, requestId);
  }

  async reply(
    actor: AcademyActor,
    requestId: string,
    body: string,
  ): Promise<CustomerRequestDetailResponse> {
    const eventId = await this.run(actor, async (tx) => {
      const request = await this.lockOwn(tx, actor, requestId);
      if (isClosed(request.status)) {
        throw new ConflictException({ messageKey: 'errors.customerRequest.closed' });
      }
      const actorName = await this.actorName(tx, actor.userId);
      const now = new Date();
      const message = await tx.customerRequestEvent.create({
        data: {
          requestId,
          organizationId: actor.organizationId,
          kind: 'customer_message',
          visibility: 'customer',
          actorUserId: actor.userId,
          actorName,
          actorSide: 'customer',
          body,
        },
      });
      // The answer the team was waiting for puts the request back in their hands.
      let nextStatus: CustomerRequestStatus = request.status;
      if (request.status === 'waiting_for_customer') {
        nextStatus = 'in_progress';
        await tx.customerRequestEvent.create({
          data: {
            requestId,
            organizationId: actor.organizationId,
            kind: 'status_changed',
            visibility: 'customer',
            actorUserId: actor.userId,
            actorName,
            actorSide: 'customer',
            fromStatus: request.status,
            toStatus: nextStatus,
          },
        });
      }
      await tx.customerRequest.update({
        where: { id: requestId },
        data: { status: nextStatus, lastActivityAt: now },
      });
      await this.auditLogWriterService.write(tx, {
        actorUserId: actor.userId,
        organizationId: actor.organizationId,
        academyId: actor.academyId,
        role: actor.role,
        action: 'customer_request.customer_replied',
        targetType: 'customer_request',
        targetId: requestId,
        targetLabel: request.title,
      });
      return message.id;
    });
    await this.notifier.notifyTeam({
      requestId,
      eventId,
      event: 'customer_message',
      body,
    });
    return this.get(actor, requestId);
  }

  private async findByClientId(
    actor: AcademyActor,
    clientRequestId: string,
  ): Promise<CustomerRequestDetailResponse | null> {
    const existing = await this.run(actor, (tx) =>
      tx.customerRequest.findUnique({
        where: {
          requesterUserId_clientRequestId: {
            requesterUserId: actor.userId,
            clientRequestId,
          },
        },
        select: { id: true, academyId: true },
      }),
    );
    if (!existing) return null;
    if (existing.academyId !== actor.academyId) {
      throw new ConflictException({
        messageKey: 'errors.customerRequest.duplicateClientId',
      });
    }
    return this.get(actor, existing.id);
  }

  /** Row-locks the request (a reply and a cancel cannot interleave) — this academy's only. */
  private async lockOwn(
    tx: Prisma.TransactionClient,
    actor: AcademyActor,
    requestId: string,
  ) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "customer_requests"
       WHERE "id" = ${requestId} AND "academy_id" = ${actor.academyId}
       FOR UPDATE
    `;
    if (rows.length === 0) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return tx.customerRequest.findUniqueOrThrow({ where: { id: requestId } });
  }

  private async actorName(tx: Prisma.TransactionClient, userId: string): Promise<string> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    return user?.name ?? '';
  }
}
