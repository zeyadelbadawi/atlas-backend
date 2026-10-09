/**
 * Customer Requests — the notifications that need platform visibility,
 * sent AFTER the customer's own transaction committed.
 *
 * The routing table (request type → team inbox) is readable by Platform
 * Owners only, so the customer's transaction cannot read it, and must not:
 * a tenant never learns where its requests are routed. These run in a
 * Platform-Owner-anchored transaction instead, exactly like the contact
 * inbox's notifications (`PlatformContactIntakeService`).
 *
 * NEVER THROWS. The request is already saved and visible in the console;
 * a notification failure is logged, not surfaced to the customer. Every
 * emit is deduped on the event id, so a retry can never mail twice.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { CommunicationService } from '../../communications/services/communication.service';
import { NOTIFY_BATCH_SIZE } from '../customer-requests.constants';
import { excerpt, requestReference } from '../customer-request.mapper';

export interface RequestNotice {
  readonly requestId: string;
  readonly eventId: string;
  /** `created` — a new request; `customer_message` — the academy replied. */
  readonly event: 'created' | 'customer_message';
  readonly body: string;
}

const ENTITY_TYPE = 'customer_request';

@Injectable()
export class CustomerRequestNotifierService {
  private readonly logger = new Logger(CustomerRequestNotifierService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly communicationService: CommunicationService,
  ) {}

  async notifyTeam(notice: RequestNotice): Promise<void> {
    try {
      const anchor = await this.usersRepository.findFirstPlatformOwnerId();
      if (!anchor) {
        this.logger.warn(
          { requestId: notice.requestId },
          'No platform owner account exists; customer request stored without a notification.',
        );
        return;
      }
      const outboxIds = await this.tenancyContextService.runInUserContext(
        anchor.id,
        (tx) => this.emitTeamNotices(tx, notice),
      );
      for (const outboxId of outboxIds) {
        await this.communicationService.enqueueAfterCommit(outboxId);
      }
    } catch (error) {
      this.logger.error(
        {
          requestId: notice.requestId,
          event: notice.event,
          error: error instanceof Error ? error.message : String(error),
        },
        'Customer request saved, but notifying the team failed.',
      );
    }
  }

  private async emitTeamNotices(
    tx: Prisma.TransactionClient,
    notice: RequestNotice,
  ): Promise<(string | null)[]> {
    const request = await tx.customerRequest.findUnique({
      where: { id: notice.requestId },
      include: { academy: { select: { name: true } } },
    });
    if (!request) return [];

    const owners = await tx.user.findMany({
      where: { isPlatformOwner: true, status: 'active', deletedAt: null },
      select: { id: true, email: true },
      orderBy: { createdAt: 'asc' },
    });
    const rule = await tx.customerRequestRoutingRule.findUnique({
      where: { type: request.type },
    });

    const values = {
      eventId: notice.eventId,
      event: notice.event,
      reference: requestReference(request.id),
      type: request.type,
      title: request.title,
      priority: request.priority,
      academyName: request.academy.name,
      requesterName: request.requesterName,
      requesterEmail: request.requesterEmail,
      excerpt: excerpt(notice.body),
    };
    const entity = { type: ENTITY_TYPE, id: request.id };
    const ids: (string | null)[] = [];

    // 1. Email: the configured team inbox; with none configured, every
    //    active Platform Owner — a request is never routed to nobody.
    const inboxes = rule
      ? [rule.email]
      : owners.map((owner) => owner.email).filter((email) => !!email);
    for (const email of new Set(inboxes)) {
      const emitted = await this.communicationService.emitToAddress(tx, {
        key: 'customer_request.routed',
        email,
        entity,
        values,
      });
      ids.push(emitted.outboxId);
    }

    // 2. The console feed: a new request → every Platform Owner; a customer
    //    reply → its assignee, or everyone while it is unassigned.
    const feed =
      notice.event === 'customer_message' && request.assignedToUserId
        ? [request.assignedToUserId]
        : owners.map((owner) => owner.id);
    const key =
      notice.event === 'created'
        ? ('customer_request.received' as const)
        : ('customer_request.customer_replied' as const);
    for (let start = 0; start < feed.length; start += NOTIFY_BATCH_SIZE) {
      for (const recipientUserId of feed.slice(start, start + NOTIFY_BATCH_SIZE)) {
        const emitted = await this.communicationService.emit(tx, {
          key,
          recipientUserId,
          entity,
          values: {
            eventId: notice.eventId,
            title: request.title,
            type: request.type,
            academyName: request.academy.name,
            excerpt: excerpt(notice.body),
          },
        });
        ids.push(emitted.outboxId);
      }
    }
    return ids;
  }
}
