/**
 * B0-SEC-13 — the Platform Owner's queue of privacy requests.
 *
 * Every read and write runs in the operator's own context: the
 * `privacy_requests_platform_*` policies admit Platform Owners only, and
 * `PlatformOwnerGuard` re-reads `is_platform_owner` on every request before
 * this is reached.
 *
 * Fulfilment:
 *   - export → the request completes and the requester may download their
 *     data from their profile for `EXPORT_WINDOW_MS`; they are emailed.
 *   - deletion → the account is deleted through the EXISTING Platform Owner
 *     path (`AccountDeletionService.deleteUserAsPlatformOwner`, which
 *     re-checks the actor and writes its own audit row), then the request
 *     completes, the person is emailed at the address recorded on the
 *     request, and that address is masked on the row.
 * Declining requires a reason, which the person is told.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PrivacyRequest, Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CommunicationService } from '../../communications/services/communication.service';
import { AccountDeletionService } from '../../identity/services/account-deletion.service';
import { maskEmail } from '../../identity/services/email-otp.service';
import { utcLabel } from '../../communications/services/quiz-exception-values.util';
import {
  buildPaginationMeta,
  type PaginatedResult,
} from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { ListPrivacyRequestsQueryDto } from '../dto/list-privacy-requests-query.dto';
import type { UpdatePrivacyRequestStatusDto } from '../dto/update-privacy-request-status.dto';
import {
  toPlatformPrivacyRequestResponse,
  type PlatformPrivacyRequestResponse,
} from '../dto/privacy-request.contract';
import {
  EXPORT_WINDOW_MS,
  MANUAL_TRANSITIONS,
  OPEN_STATUSES,
} from '../privacy-requests.constants';

type Tx = Prisma.TransactionClient;

@Injectable()
export class PlatformPrivacyRequestsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly communicationService: CommunicationService,
    private readonly accountDeletionService: AccountDeletionService,
  ) {}

  async list(
    platformOwnerId: string,
    query: ListPrivacyRequestsQueryDto,
  ): Promise<PaginatedResult<PlatformPrivacyRequestResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.PrivacyRequestWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const [rows, totalItems] = await Promise.all([
        tx.privacyRequest.findMany({
          where,
          // Oldest open work first is what a queue is for; `createdAt`
          // ascending within the filter keeps the waiting ones on top.
          orderBy: { createdAt: query.sortDirection === 'desc' ? 'desc' : 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.privacyRequest.count({ where }),
      ]);
      const names = await this.academyNames(tx, rows);
      return {
        items: rows.map((row) =>
          toPlatformPrivacyRequestResponse(
            row,
            row.academyId ? (names.get(row.academyId) ?? null) : null,
          ),
        ),
        pagination: buildPaginationMeta(page, pageSize, totalItems),
      };
    });
  }

  async get(
    platformOwnerId: string,
    id: string,
  ): Promise<PlatformPrivacyRequestResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const row = await this.findOrThrow(tx, id);
      const names = await this.academyNames(tx, [row]);
      return toPlatformPrivacyRequestResponse(
        row,
        row.academyId ? (names.get(row.academyId) ?? null) : null,
      );
    });
  }

  async updateStatus(
    platformOwnerId: string,
    id: string,
    dto: UpdatePrivacyRequestStatusDto,
  ): Promise<PlatformPrivacyRequestResponse> {
    const { response, outboxId } = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => {
        const row = await this.findOrThrow(tx, id);
        if (!MANUAL_TRANSITIONS[row.status].includes(dto.status)) {
          throw new ConflictException({
            messageKey: 'errors.privacyRequest.invalidTransition',
          });
        }
        const note = dto.status === 'rejected' ? (dto.note?.trim() ?? '') : null;
        if (dto.status === 'rejected' && !note) {
          throw new BadRequestException({
            messageKey: 'errors.privacyRequest.noteRequired',
          });
        }
        const updated = await this.claim(tx, row, {
          status: dto.status,
          handledByUserId: platformOwnerId,
          ...(dto.status === 'rejected'
            ? { resolutionNote: note, completedAt: new Date() }
            : {}),
        });
        await this.auditLogWriterService.write(tx, {
          actorUserId: platformOwnerId,
          action: 'privacy_request.status_changed',
          targetType: 'privacy_request',
          targetId: row.id,
          context: {
            requestType: row.type,
            userId: row.userId,
            fromStatus: row.status,
            toStatus: dto.status,
          },
        });
        let emittedId: string | null = null;
        if (dto.status === 'rejected' && row.userId) {
          const emitted = await this.communicationService.emit(tx, {
            key: 'privacy_request.rejected',
            recipientUserId: row.userId,
            organizationId: null,
            academyId: row.academyId,
            entity: { type: 'privacy_request', id: row.id },
            values: { requestType: row.type, note },
          });
          emittedId = emitted.outboxId;
        }
        const names = await this.academyNames(tx, [updated]);
        return {
          response: toPlatformPrivacyRequestResponse(
            updated,
            updated.academyId ? (names.get(updated.academyId) ?? null) : null,
          ),
          outboxId: emittedId,
        };
      },
    );
    await this.communicationService.enqueueAfterCommit(outboxId);
    return response;
  }

  async fulfil(
    platformOwnerId: string,
    id: string,
  ): Promise<PlatformPrivacyRequestResponse> {
    const row = await this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
      this.findOrThrow(tx, id),
    );
    if (!OPEN_STATUSES.includes(row.status)) {
      throw new ConflictException({
        messageKey: 'errors.privacyRequest.invalidTransition',
      });
    }
    if (!row.userId) {
      throw new ConflictException({ messageKey: 'errors.privacyRequest.accountGone' });
    }
    return row.type === 'export'
      ? this.fulfilExport(platformOwnerId, row, row.userId)
      : this.fulfilDeletion(platformOwnerId, row, row.userId);
  }

  private async fulfilExport(
    platformOwnerId: string,
    row: PrivacyRequest,
    userId: string,
  ): Promise<PlatformPrivacyRequestResponse> {
    const now = new Date();
    const availableUntil = new Date(now.getTime() + EXPORT_WINDOW_MS);
    const { response, outboxId } = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => {
        const updated = await this.claim(tx, row, {
          status: 'completed',
          handledByUserId: platformOwnerId,
          exportAvailableUntil: availableUntil,
          completedAt: now,
        });
        await this.auditFulfilled(tx, platformOwnerId, row, availableUntil);
        const emitted = await this.communicationService.emit(tx, {
          key: 'privacy_request.export_ready',
          recipientUserId: userId,
          organizationId: null,
          academyId: row.academyId,
          entity: { type: 'privacy_request', id: row.id },
          values: { availableUntilDate: utcLabel(availableUntil) },
        });
        const names = await this.academyNames(tx, [updated]);
        return {
          response: toPlatformPrivacyRequestResponse(
            updated,
            updated.academyId ? (names.get(updated.academyId) ?? null) : null,
          ),
          outboxId: emitted.outboxId,
        };
      },
    );
    await this.communicationService.enqueueAfterCommit(outboxId);
    return response;
  }

  private async fulfilDeletion(
    platformOwnerId: string,
    row: PrivacyRequest,
    userId: string,
  ): Promise<PlatformPrivacyRequestResponse> {
    // The language of the goodbye email, read before anonymisation clears it.
    const preferred = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) =>
        (
          (
            await tx.user.findUnique({
              where: { id: userId },
              select: { preferences: true },
            })
          )?.preferences as { language?: unknown } | null
        )?.language,
    );

    // The existing, idempotent Platform Owner deletion: it re-checks the
    // actor, refuses a Platform Owner target, and audits the deletion.
    await this.accountDeletionService.deleteUserAsPlatformOwner(
      platformOwnerId,
      userId,
      {},
    );

    const now = new Date();
    const { response, outboxId } = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => {
        const updated = await this.claim(tx, row, {
          status: 'completed',
          handledByUserId: platformOwnerId,
          completedAt: now,
          // The account is gone; keep only a masked trace of who asked.
          requesterEmail: maskEmail(row.requesterEmail),
        });
        await this.auditFulfilled(tx, platformOwnerId, row, null);
        const emitted = await this.communicationService.emitToAddress(tx, {
          key: 'privacy_request.deletion_completed',
          email: row.requesterEmail,
          entity: { type: 'privacy_request', id: row.id },
          locale: preferred === 'ar' ? 'ar' : 'en',
        });
        return {
          response: toPlatformPrivacyRequestResponse(updated, null),
          outboxId: emitted.outboxId,
        };
      },
    );
    await this.communicationService.enqueueAfterCommit(outboxId);
    return response;
  }

  /**
   * One conditional UPDATE from the status the caller read: two operators
   * acting on the same request at once cannot both succeed.
   */
  private async claim(
    tx: Tx,
    row: PrivacyRequest,
    data: Prisma.PrivacyRequestUpdateManyMutationInput,
  ): Promise<PrivacyRequest> {
    const claimed = await tx.privacyRequest.updateMany({
      where: { id: row.id, status: row.status },
      data,
    });
    if (claimed.count !== 1) {
      throw new ConflictException({
        messageKey: 'errors.privacyRequest.invalidTransition',
      });
    }
    return this.findOrThrow(tx, row.id);
  }

  private async auditFulfilled(
    tx: Tx,
    platformOwnerId: string,
    row: PrivacyRequest,
    exportAvailableUntil: Date | null,
  ): Promise<void> {
    await this.auditLogWriterService.write(tx, {
      actorUserId: platformOwnerId,
      action: 'privacy_request.fulfilled',
      targetType: 'privacy_request',
      targetId: row.id,
      context: {
        requestType: row.type,
        userId: row.userId,
        exportAvailableUntil: exportAvailableUntil?.toISOString() ?? null,
      },
    });
  }

  private async findOrThrow(tx: Tx, id: string): Promise<PrivacyRequest> {
    const row = await tx.privacyRequest.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return row;
  }

  private async academyNames(
    tx: Tx,
    rows: readonly PrivacyRequest[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(rows.map((row) => row.academyId).filter((id): id is string => !!id)),
    ];
    if (!ids.length) return new Map();
    const academies = await tx.academy.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(academies.map((academy) => [academy.id, academy.name]));
  }
}
