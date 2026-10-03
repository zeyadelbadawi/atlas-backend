/**
 * PlatformContactSubmissionsService — the Platform Owner's inbox for the
 * Atlas marketing contact form (`platform/contact-submissions`).
 *
 * Every read and write runs under
 * `TenancyContextService.runInUserContext(platformOwnerId)`, relying on
 * the `platform_contact_submissions_platform_*` RLS policies — the guard
 * stack in the controller and the database agree without depending on each
 * other. A row the caller cannot see is a 404, never a 403.
 *
 * A status change and a delete each write their audit entry in the SAME
 * transaction as the mutation (`AuditLogWriterService.write`), so the
 * record and the change commit or roll back together. The audit entry
 * carries the enquiry's id and status only (the catalogue's allowlist for
 * these actions) — never the visitor's name, address or message.
 *
 * A delete also takes back the copies the new-enquiry notification made
 * (`CommunicationService.forgetEntity`), in the same transaction: the
 * outbox rows for this enquiry lose the visitor's details, and any email
 * not yet sent is suppressed. The in-app rows never held them (the
 * catalogue entry's `personalValues`).
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CommunicationService } from '../../communications/services/communication.service';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import { PlatformContactSubmissionsRepository } from '../repositories/platform-contact-submissions.repository';
import type { ListPlatformContactSubmissionsQueryDto } from '../dto/list-platform-contact-submissions-query.dto';
import type { UpdatePlatformContactSubmissionStatusDto } from '../dto/update-platform-contact-submission-status.dto';
import {
  toPlatformContactSubmissionResponse,
  type PlatformContactSubmissionResponse,
  type PlatformContactSubmissionSummaryResponse,
} from '../dto/platform-contact-submission.contract';
import {
  PLATFORM_CONTACT_AUDIT_ACTIONS,
  PLATFORM_CONTACT_AUDIT_TARGET,
  PLATFORM_CONTACT_NOTIFICATION,
} from '../platform-contact.constants';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PlatformContactSubmissionsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly repository: PlatformContactSubmissionsRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly communicationService: CommunicationService,
  ) {}

  async list(
    platformOwnerId: string,
    query: ListPlatformContactSubmissionsQueryDto,
  ): Promise<PaginatedResult<PlatformContactSubmissionResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined;
    const toExclusive = query.to
      ? new Date(new Date(`${query.to}T00:00:00.000Z`).getTime() + DAY_MS)
      : undefined;

    const { items, totalItems } = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) =>
        this.repository.findMany(tx, {
          skip: (page - 1) * pageSize,
          take: pageSize,
          search: query.search,
          status: query.status,
          topic: query.topic,
          from: from && !Number.isNaN(from.getTime()) ? from : undefined,
          toExclusive:
            toExclusive && !Number.isNaN(toExclusive.getTime()) ? toExclusive : undefined,
          sortBy: query.sortBy,
          sortDirection: query.sortDirection,
        }),
    );

    return {
      items: items.map(toPlatformContactSubmissionResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async summary(
    platformOwnerId: string,
  ): Promise<PlatformContactSubmissionSummaryResponse> {
    const counts = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) => this.repository.countByStatus(tx),
    );
    return {
      total: counts.new + counts.read + counts.archived,
      new: counts.new,
      read: counts.read,
      archived: counts.archived,
    };
  }

  async getById(
    platformOwnerId: string,
    id: string,
  ): Promise<PlatformContactSubmissionResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) =>
      toPlatformContactSubmissionResponse(await this.loadOrThrow(tx, id)),
    );
  }

  async updateStatus(
    platformOwnerId: string,
    id: string,
    payload: UpdatePlatformContactSubmissionStatusDto,
  ): Promise<PlatformContactSubmissionResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const current = await this.loadOrThrow(tx, id);
      if (current.status === payload.status) {
        // Nothing changed — no write, no audit row for a no-op.
        return toPlatformContactSubmissionResponse(current);
      }
      const updated = await this.repository.updateStatus(
        tx,
        current,
        payload.status,
        new Date(),
      );
      await this.auditLogWriterService.write(tx, {
        actorUserId: platformOwnerId,
        role: 'platform_owner',
        action: PLATFORM_CONTACT_AUDIT_ACTIONS.statusChanged,
        targetType: PLATFORM_CONTACT_AUDIT_TARGET,
        targetId: id,
        context: { status: updated.status, previousStatus: current.status },
        changes: { status: { from: current.status, to: updated.status } },
      });
      return toPlatformContactSubmissionResponse(updated);
    });
  }

  async delete(platformOwnerId: string, id: string): Promise<void> {
    await this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const current = await this.loadOrThrow(tx, id);
      await this.repository.delete(tx, id);
      await this.communicationService.forgetEntity(
        tx,
        PLATFORM_CONTACT_NOTIFICATION.key,
        {
          type: PLATFORM_CONTACT_NOTIFICATION.entityType,
          id,
        },
      );
      await this.auditLogWriterService.write(tx, {
        actorUserId: platformOwnerId,
        role: 'platform_owner',
        action: PLATFORM_CONTACT_AUDIT_ACTIONS.deleted,
        targetType: PLATFORM_CONTACT_AUDIT_TARGET,
        targetId: id,
        context: { status: current.status },
      });
    });
  }

  private async loadOrThrow(tx: Prisma.TransactionClient, id: string) {
    const row = await this.repository.findById(tx, id);
    if (!row) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return row;
  }
}
