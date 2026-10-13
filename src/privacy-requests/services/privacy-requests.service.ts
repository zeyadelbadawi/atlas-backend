/**
 * B0-SEC-13 — the requester's side of a privacy request.
 *
 *   1. `requestCode` emails a code to the caller's verified address
 *      (`AccountDeletionChallengeService`, purpose `privacy_request`: bound
 *      to this account, this session and this purpose).
 *   2. `file` consumes the code once, then stores the request in the
 *      caller's own RLS context. One open request per type: a retry or a
 *      second tab returns the open one. The requester is emailed a receipt
 *      and every Platform Owner is alerted (after commit, best-effort).
 *   3. `listMine` / `downloadExport` — the caller's own requests; a
 *      fulfilled export is downloaded here, signed in, until its window
 *      closes. There is no bearer link: a forwarded email hands over nothing.
 *
 * Works from an academy session as well as a management session: a learner
 * has no other way in. The academy the request was filed from only chooses
 * the email's branding — it never scopes who can read the request.
 */
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrivacyRequest } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CommunicationService } from '../../communications/services/communication.service';
import { PlatformOwnerAlertService } from '../../communications/services/platform-owner-alert.service';
import {
  AccountDeletionChallengeService,
  type AccountDeletionChallengeContract,
} from '../../identity/services/account-deletion-challenge.service';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import type { FilePrivacyRequestDto } from '../dto/file-privacy-request.dto';
import {
  canDownloadExport,
  toMyPrivacyRequestResponse,
  type MyPrivacyRequestResponse,
} from '../dto/privacy-request.contract';
import { OPEN_STATUSES } from '../privacy-requests.constants';
import {
  assemblePrivacyExport,
  type PrivacyExportBundle,
} from './privacy-export.assembler';

/** The requester's own history, newest first — a handful at most in practice. */
const MY_REQUESTS_LIMIT = 20;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class PrivacyRequestsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly communicationService: CommunicationService,
    private readonly platformOwnerAlertService: PlatformOwnerAlertService,
    private readonly challengeService: AccountDeletionChallengeService,
  ) {}

  requestCode(auth: AuthContext): Promise<AccountDeletionChallengeContract> {
    return this.challengeService.issue(auth.userId, auth.sessionId, 'privacy_request');
  }

  async file(
    auth: AuthContext,
    dto: FilePrivacyRequestDto,
  ): Promise<MyPrivacyRequestResponse> {
    // Only the emailed code, issued to THIS session for THIS purpose,
    // authorises filing; it is consumed exactly once.
    await this.challengeService.consume(
      auth.userId,
      auth.sessionId,
      dto.challengeId,
      dto.code,
      'privacy_request',
    );

    let outcome: { row: PrivacyRequest; created: boolean; outboxId: string | null };
    try {
      outcome = await this.createOrReturnOpen(auth, dto);
    } catch (error) {
      // Two concurrent submissions: the partial unique index let one in.
      if (!isUniqueViolation(error)) throw error;
      const open = await this.findOpen(auth.userId, dto.type);
      if (!open) throw error;
      outcome = { row: open, created: false, outboxId: null };
    }

    if (outcome.created) {
      await this.communicationService.enqueueAfterCommit(outcome.outboxId);
      this.platformOwnerAlertService.notify({
        key: 'platform.privacy_request.created',
        entity: { type: 'privacy_request', id: outcome.row.id },
        values: { requestType: outcome.row.type },
      });
    }
    return toMyPrivacyRequestResponse(outcome.row);
  }

  async listMine(userId: string): Promise<MyPrivacyRequestResponse[]> {
    const rows = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      tx.privacyRequest.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: MY_REQUESTS_LIMIT,
      }),
    );
    const now = new Date();
    return rows.map((row) => toMyPrivacyRequestResponse(row, now));
  }

  /**
   * The caller's data, while their fulfilled export's window is open. Any
   * other case — not theirs, not an export, not fulfilled, expired — is the
   * same 404, so the endpoint reveals nothing about other requests.
   */
  async downloadExport(userId: string, requestId: string): Promise<PrivacyExportBundle> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const row = await tx.privacyRequest.findFirst({ where: { id: requestId, userId } });
      if (!row || !canDownloadExport(row)) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      const bundle = await assemblePrivacyExport(tx, userId);
      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        action: 'privacy_request.export_downloaded',
        targetType: 'privacy_request',
        targetId: row.id,
        context: { requestType: row.type },
      });
      return bundle;
    });
  }

  private findOpen(userId: string, type: FilePrivacyRequestDto['type']) {
    return this.tenancyContextService.runInUserContext(userId, (tx) =>
      tx.privacyRequest.findFirst({
        where: { userId, type, status: { in: [...OPEN_STATUSES] } },
      }),
    );
  }

  private createOrReturnOpen(auth: AuthContext, dto: FilePrivacyRequestDto) {
    const userId = auth.userId;
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const open = await tx.privacyRequest.findFirst({
        where: { userId, type: dto.type, status: { in: [...OPEN_STATUSES] } },
      });
      if (open) return { row: open, created: false, outboxId: null };

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { email: true, name: true, status: true, isPlatformOwner: true },
      });
      if (!user || user.status !== 'active') {
        throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
      }
      if (user.isPlatformOwner) {
        throw new ForbiddenException({ messageKey: 'errors.forbidden' });
      }

      const row = await tx.privacyRequest.create({
        data: {
          id: randomUUID(),
          userId,
          academyId: auth.surface === 'academy' ? auth.academyId : null,
          type: dto.type,
          requesterEmail: user.email,
          requesterName: user.name,
        },
      });
      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        action: 'privacy_request.submitted',
        targetType: 'privacy_request',
        targetId: row.id,
        context: { requestType: row.type, userId },
      });
      const emitted = await this.communicationService.emit(tx, {
        key: 'privacy_request.received',
        recipientUserId: userId,
        // Never tenant-visible: an academy does not see a learner's request.
        organizationId: null,
        academyId: row.academyId,
        entity: { type: 'privacy_request', id: row.id },
        values: { requestType: row.type },
      });
      return { row, created: true, outboxId: emitted.outboxId };
    });
  }
}
