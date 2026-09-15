/**
 * SupportCasesService — `GET /support-cases`/`GET /support-cases/:id`/
 * `PATCH /support-cases/:id/status`/`POST /support-cases/:id/messages`
 * (master plan §21 Phase P15). Every read/write runs under
 * `TenancyContextService.runInUserContext(platformOwnerId)`, relying on
 * the `support_cases_platform_*`/`support_case_messages_platform_*` RLS
 * policies. Status accepts any of the four standard lifecycle values
 * (`open`/`in_progress`/`resolved`/`closed`, DTO-validated) — no
 * transition matrix is invented (e.g. "cannot reopen a closed case"):
 * the frontend contract defines the lifecycle's four states, not a
 * transition graph, and inventing restrictions it never specifies would
 * violate this phase's own "do not invent business behavior" rule.
 *
 * `postReply` writes the new message AND bumps the case's `updatedAt` in
 * ONE transaction — a reply is real activity on the case even though its
 * `status` is untouched, matching the frontend's own `updatedAt` "last
 * activity" semantics (`SupportCaseSummary.updatedAt`).
 *
 * `authorName`/`authorRole` for a Platform-Owner-authored reply are
 * resolved from the ACTING Platform Owner's own `users` row — never a
 * client-supplied name, matching every other "who did this" field in this
 * codebase being server-resolved from the authenticated actor, not the
 * request body.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { SupportCasesRepository } from '../repositories/support-cases.repository';
import { SupportCaseMessagesRepository } from '../repositories/support-case-messages.repository';
import { SupportCaseMessageAttachmentsRepository } from '../repositories/support-case-message-attachments.repository';
import {
  MEDIA_STORAGE_PROVIDER,
  type MediaStorageProvider,
} from '../../media/storage/media-storage.interface';
import {
  assertWithinSizeLimit,
  buildSupportAttachmentStorageKey,
  detectFileKind,
  parseDataUrl,
  sanitizeFileName,
} from '../../media/utils/file-validation.util';
import type { MediaStorageConfig } from '../../config/configuration';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { NotificationFanoutService } from '../../notification-events/services/notification-fanout.service';
import {
  toSupportCaseDetailResponse,
  toSupportCaseSummaryResponse,
} from '../dto/support-case.contract';
import type {
  SupportCaseDetailResponse,
  SupportCaseSummaryResponse,
} from '../dto/support-case.contract';
import type { UpdateSupportCaseStatusDto } from '../dto/update-support-case-status.dto';
import type { PostSupportCaseReplyDto } from '../dto/post-support-case-reply.dto';
import type { CreateSupportCaseDto } from '../dto/create-support-case.dto';
import type { ListSupportCasesQueryDto } from '../dto/list-support-cases-query.dto';
import type { SupportAttachmentInputDto } from '../dto/support-attachment.dto';
import type { Prisma } from '@prisma/client';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';

@Injectable()
export class SupportCasesService {
  private readonly storageConfig: MediaStorageConfig;

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly supportCasesRepository: SupportCasesRepository,
    private readonly supportCaseMessagesRepository: SupportCaseMessagesRepository,
    private readonly supportCaseMessageAttachmentsRepository: SupportCaseMessageAttachmentsRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly notificationFanoutService: NotificationFanoutService,
    @Inject(MEDIA_STORAGE_PROVIDER)
    private readonly storageProvider: MediaStorageProvider,
    configService: ConfigService,
  ) {
    this.storageConfig = configService.getOrThrow<MediaStorageConfig>('media');
  }

  async listCases(
    platformOwnerId: string,
    query: ListSupportCasesQueryDto,
  ): Promise<PaginatedResult<SupportCaseSummaryResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) =>
        this.supportCasesRepository.findMany(tx, {
          search: query.search,
          status: query.status,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      items: items.map(toSupportCaseSummaryResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getCase(
    platformOwnerId: string,
    caseId: string,
  ): Promise<SupportCaseDetailResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const supportCase = await this.loadCaseOrThrow(tx, caseId);
      const messages = await this.supportCaseMessagesRepository.findManyForCase(
        tx,
        caseId,
      );
      return toSupportCaseDetailResponse(
        supportCase,
        messages,
        await this.findThreadAttachments(tx, messages),
      );
    });
  }

  async updateStatus(
    platformOwnerId: string,
    caseId: string,
    payload: UpdateSupportCaseStatusDto,
  ): Promise<SupportCaseDetailResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const before = await this.loadCaseOrThrow(tx, caseId);

      const updated = await this.supportCasesRepository.updateStatus(
        tx,
        caseId,
        payload.status,
      );
      await this.auditLogWriterService.write(tx, {
        actorUserId: platformOwnerId,
        organizationId: updated.organizationId ?? undefined,
        action: 'support_case.status_changed',
        targetType: 'support_case',
        targetId: caseId,
        targetLabel: updated.subject,
        context: { status: payload.status },
      });

      // Phase P17 — notify the case's requester (in-app only; no email
      // template for a status change alone — see this phase's own
      // "do not email every in-app notification by default" instruction).
      // No requester attached (a case created without one) → nothing to
      // notify, not an error.
      if (before.requesterUserId) {
        await this.notificationFanoutService.notify(tx, {
          userId: before.requesterUserId,
          type: 'activity',
          priority: 'low',
          titleKey: 'notifications:events.supportCaseStatusChanged.title',
          messageKey: 'notifications:events.supportCaseStatusChanged.message',
          values: { subject: updated.subject, status: payload.status },
          dedupeKey: `support_case_status_changed:${caseId}:${payload.status}`,
        });
      }

      const messages = await this.supportCaseMessagesRepository.findManyForCase(
        tx,
        caseId,
      );
      return toSupportCaseDetailResponse(
        updated,
        messages,
        await this.findThreadAttachments(tx, messages),
      );
    });
  }

  async postReply(
    platformOwnerId: string,
    caseId: string,
    payload: PostSupportCaseReplyDto,
  ): Promise<SupportCaseDetailResponse> {
    const agent = await this.usersRepository.findById(platformOwnerId);
    if (!agent) {
      // Structurally unreachable — `PlatformOwnerGuard` already re-read
      // this exact row moments ago — kept as a real check, never an
      // assertion (matches `OrganizationsService.getById`'s own rule).
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    let notifiedNew = false;
    let recipientUserId: string | null = null;
    let subjectForEmail = '';

    const result = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => {
        const supportCase = await this.loadCaseOrThrow(tx, caseId);

        await this.supportCaseMessagesRepository.create(tx, {
          caseId,
          authorName: agent.name,
          authorRole: 'agent',
          body: payload.body,
        });
        const touched = await this.supportCasesRepository.touch(tx, caseId);
        await this.auditLogWriterService.write(tx, {
          actorUserId: platformOwnerId,
          organizationId: supportCase.organizationId ?? undefined,
          action: 'support_case.replied',
          targetType: 'support_case',
          targetId: caseId,
          targetLabel: supportCase.subject,
        });

        // Phase P17 — notify the requester a reply landed (master plan
        // §12's own explicit email producer list names "Support (reply)").
        if (supportCase.requesterUserId) {
          recipientUserId = supportCase.requesterUserId;
          subjectForEmail = supportCase.subject;
          notifiedNew = await this.notificationFanoutService.notify(tx, {
            userId: supportCase.requesterUserId,
            type: 'activity',
            priority: 'medium',
            titleKey: 'notifications:events.supportCaseReply.title',
            messageKey: 'notifications:events.supportCaseReply.message',
            values: { subject: supportCase.subject },
            // No dedupe key — unlike a webhook/queued job, posting a reply
            // is a single, direct, human-initiated action with no
            // redelivery risk, and there is no stable natural key
            // available before the message row itself is created (its own
            // `id` doesn't exist yet at this point). A genuine duplicate
            // reply notification would only occur if this exact HTTP
            // request were somehow re-executed, not a realistic risk this
            // phase needs to guard against.
            dedupeKey: null,
          });
        }

        const messages = await this.supportCaseMessagesRepository.findManyForCase(
          tx,
          caseId,
        );
        return toSupportCaseDetailResponse(
          touched,
          messages,
          await this.findThreadAttachments(tx, messages),
        );
      },
    );

    if (recipientUserId) {
      await this.notificationFanoutService.sendEmailAfterCommit(
        recipientUserId,
        notifiedNew,
        {
          template: 'support_case_reply',
          values: { subject: subjectForEmail },
        },
      );
    }

    return result;
  }

  /**
   * Phase 8 — the tenant-facing create path (`POST organizations/:id/
   * support-cases`/`POST academies/:id/support-cases`). `requesterName`/
   * `requesterEmail` are resolved from the caller's OWN `users` row —
   * never client-supplied — matching `postReply`'s identical rule for a
   * Platform-Owner-authored reply above. `description` becomes the
   * case's first message, same transaction as the case row itself: a
   * rollback of one is a rollback of both, never a subject with no body
   * or a body with no case.
   *
   * `role` is the caller's real Organization/Academy-membership role at
   * the moment of creation (`'owner'`/`'manager'`/...), resolved by the
   * CONTROLLER from whichever guard ran (`OrganizationMembershipGuard`/
   * `AcademyScopeGuard`) — this service never re-derives it, matching
   * `AuditLogWriteInput.role`'s own doc comment.
   */
  async createCase(
    organizationId: string,
    userId: string,
    academyId: string | null,
    role: string,
    payload: CreateSupportCaseDto,
  ): Promise<SupportCaseDetailResponse> {
    const requester = await this.usersRepository.findById(userId);
    if (!requester) {
      // Structurally unreachable — the guard that ran before this
      // controller method already re-read a real membership row for this
      // exact user — kept as a real check, never an assertion, matching
      // `postReply`'s identical rule above.
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    // The case id an attachment's storage key needs does not exist until
    // the row below is created, so the object write happens INSIDE the
    // transaction's flow but keyed on the id we generate for the case
    // first. Rather than restructure `create`, the attachment is stored
    // after the case row exists and before the message row references it —
    // see `storeAttachment`'s own note on ordering.
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        const created = await this.supportCasesRepository.create(tx, {
          organizationId,
          academyId: academyId ?? undefined,
          requesterUserId: userId,
          subject: payload.subject,
          requesterName: requester.name,
          requesterEmail: requester.email,
        });

        const firstMessage = await this.supportCaseMessagesRepository.create(tx, {
          caseId: created.id,
          authorName: requester.name,
          authorRole: 'requester',
          body: payload.description,
        });

        if (payload.attachment) {
          const stored = await this.storeAttachment(created.id, payload.attachment);
          await this.supportCaseMessageAttachmentsRepository.create(tx, {
            id: stored.id,
            messageId: firstMessage.id,
            fileName: stored.fileName,
            storageKey: stored.storageKey,
            mimeType: stored.mimeType,
            sizeBytes: stored.sizeBytes,
          });
        }

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId: academyId ?? undefined,
          role,
          action: 'support_case.created',
          targetType: 'support_case',
          targetId: created.id,
          targetLabel: created.subject,
        });

        const messages = await this.supportCaseMessagesRepository.findManyForCase(
          tx,
          created.id,
        );
        return toSupportCaseDetailResponse(
          created,
          messages,
          await this.findThreadAttachments(tx, messages),
        );
      },
    );
  }

  /**
   * Phase 8 — "my tickets" (tracking what was submitted). Scoped by the
   * `support_cases_requester_select` RLS policy to rows this exact
   * caller requested; `runInUserContext` alone is enough (no tenant
   * context needed) — mirrors `CourseOrder`'s identical "personal, not
   * organization-shared" read shape.
   */
  async listMyCases(
    userId: string,
    query: ListSupportCasesQueryDto,
  ): Promise<PaginatedResult<SupportCaseSummaryResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInUserContext(
      userId,
      (tx) =>
        this.supportCasesRepository.findManyForRequester(tx, userId, {
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      items: items.map(toSupportCaseSummaryResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  /**
   * Phase 11.8 — a requester reading their OWN ticket, with its thread.
   *
   * The tenant side could create and list tickets but had no way to read
   * one, so a customer could file a ticket and never see the reply. This
   * is the read half of that gap; `postRequesterReply` below is the write
   * half.
   *
   * ISOLATION IS THE DATABASE'S JOB, NOT A CHECK HERE. Running in the
   * caller's user context means `support_cases_requester_select` and
   * `support_case_messages_requester_select` scope both reads to rows
   * this exact person requested. Another tenant's case id — or a
   * colleague's in the same organization — simply does not exist from
   * this connection, and surfaces as the 404 below rather than as a 403
   * that would confirm the id is real.
   */
  async getMyCase(userId: string, caseId: string): Promise<SupportCaseDetailResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const supportCase = await this.loadCaseOrThrow(tx, caseId);
      const messages = await this.supportCaseMessagesRepository.findManyForCase(
        tx,
        caseId,
      );
      return toSupportCaseDetailResponse(
        supportCase,
        messages,
        await this.findThreadAttachments(tx, messages),
      );
    });
  }

  /**
   * Phase 11.8 — the requester's own reply, continuing the conversation.
   *
   * `authorRole` is hard-coded to `'requester'` here, and
   * `support_case_messages_requester_insert` independently refuses any
   * other value from a tenant connection — so a customer cannot fabricate
   * an official Atlas reply in their own thread even if this line were
   * ever changed. Two independent enforcement points for the same rule,
   * deliberately.
   *
   * A CLOSED TICKET DOES NOT ACCEPT REPLIES. `closed` is the terminal
   * state in `SUPPORT_CASE_STATUSES`; allowing writes into it would mean
   * a customer types a reply, sees it accepted, and nobody is looking at
   * that ticket any more. They are told to open a new one instead.
   * `resolved` deliberately still accepts replies — that is exactly the
   * "actually, this is not fixed" case, and it reopens the conversation.
   */
  async postRequesterReply(
    userId: string,
    caseId: string,
    payload: PostSupportCaseReplyDto,
  ): Promise<SupportCaseDetailResponse> {
    const requester = await this.usersRepository.findById(userId);
    if (!requester) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const supportCase = await this.loadCaseOrThrow(tx, caseId);

      if (supportCase.status === 'closed') {
        throw new ConflictException({
          messageKey: 'errors.support.caseClosed',
        });
      }

      const message = await this.supportCaseMessagesRepository.create(tx, {
        caseId,
        authorName: requester.name,
        authorRole: 'requester',
        body: payload.body,
      });

      if (payload.attachment) {
        const stored = await this.storeAttachment(caseId, payload.attachment);
        await this.supportCaseMessageAttachmentsRepository.create(tx, {
          id: stored.id,
          messageId: message.id,
          fileName: stored.fileName,
          storageKey: stored.storageKey,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
        });
      }

      // Moves `updatedAt`, which is what orders the agent's queue —
      // without it a customer's reply would never surface to support.
      // `touchAsRequester`, not `touch`: a requester has no UPDATE policy
      // on `support_cases`, by design. See that method's doc comment.
      const touched = await this.supportCasesRepository.touchAsRequester(tx, caseId);

      await this.auditLogWriterService.writeBestEffort(tx, {
        actorUserId: userId,
        organizationId: supportCase.organizationId ?? undefined,
        action: 'support_case.replied',
        targetType: 'support_case',
        targetId: caseId,
        targetLabel: supportCase.subject,
      });

      const messages = await this.supportCaseMessagesRepository.findManyForCase(
        tx,
        caseId,
      );
      return toSupportCaseDetailResponse(
        touched,
        messages,
        await this.findThreadAttachments(tx, messages),
      );
    });
  }

  /**
   * P53 — validates an attachment's REAL bytes and writes them to object
   * storage, returning what the row needs. Called BEFORE the database
   * transaction that creates the message, deliberately:
   *
   *   - an invalid or oversized image must be refused before any row is
   *     written, so a rejected upload never leaves a half-created ticket;
   *   - and the storage write must not happen inside an open transaction,
   *     which would hold a database connection for the duration of a
   *     network round-trip to R2.
   *
   * The trade-off is an orphaned object if the transaction afterwards
   * fails. That is the same direction `MediaService.performUpload` already
   * chose (object first, row second) and it is the safe one: a stored byte
   * range nothing references is invisible and costs storage, whereas a row
   * pointing at bytes that were never written is a broken image in a
   * customer's ticket.
   *
   * IMAGES ONLY. `detectFileKind`'s allowlist also covers PDF, but this
   * feature is specified as image attachments, so anything that is not an
   * image is refused here rather than silently accepted because the shared
   * validator happened to permit it.
   */
  private async storeAttachment(
    caseId: string,
    input: SupportAttachmentInputDto,
  ): Promise<{
    readonly id: string;
    readonly fileName: string;
    readonly storageKey: string;
    readonly mimeType: string;
    readonly sizeBytes: bigint;
  }> {
    // Never the declared `mimeType`/`sizeBytes` — the decoded buffer is the
    // only fact. Identical to `MediaService.parseAndValidate`, using the
    // very same functions rather than a second copy of the rules.
    const { buffer } = parseDataUrl(input.dataUrl);
    assertWithinSizeLimit(buffer, this.storageConfig.maxUploadBytes);

    const kind = detectFileKind(buffer);
    if (!kind) {
      throw new BadRequestException({ messageKey: 'errors.media.unsupportedFileType' });
    }
    if (kind.assetType !== 'image') {
      throw new BadRequestException({ messageKey: 'errors.media.unsupportedFileType' });
    }

    const id = randomUUID();
    const storageKey = buildSupportAttachmentStorageKey(caseId, kind.extension, id);
    await this.storageProvider.putObject(storageKey, buffer, kind.mimeType);

    return {
      id,
      fileName: sanitizeFileName(input.fileName),
      storageKey,
      mimeType: kind.mimeType,
      sizeBytes: BigInt(buffer.length),
    };
  }

  /** Loads a whole thread's attachments in one query — see `toSupportCaseDetailResponse`'s own note. */
  private async findThreadAttachments(
    tx: Prisma.TransactionClient,
    messages: readonly { id: string }[],
  ) {
    return this.supportCaseMessageAttachmentsRepository.findManyForMessages(
      tx,
      messages.map((message) => message.id),
    );
  }

  /**
   * P53 — the authenticated read behind `GET /support-cases/attachments/:id`.
   *
   * ONE CONTEXT SERVES BOTH AUDIENCES, and that is the point.
   * `runInUserContext(userId)` lets the database decide which policy
   * applies: a requester matches
   * `support_case_message_attachments_requester_select` (their own ticket
   * only), a Platform Owner matches `..._platform_select` (every ticket),
   * and anybody else matches neither. There is no `isPlatformOwner` branch
   * in this method — adding one would be a second authorization decision
   * that could disagree with the policies.
   *
   * A row the caller may not read is indistinguishable from one that does
   * not exist: both surface as 404, never 403, matching `getMyCase`'s own
   * documented rule that a 403 would confirm the id is real.
   */
  async getAttachmentBytes(
    userId: string,
    attachmentId: string,
  ): Promise<{
    readonly buffer: Buffer;
    readonly mimeType: string;
    readonly fileName: string;
  }> {
    const attachment = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      this.supportCaseMessageAttachmentsRepository.findByIdWithMessage(tx, attachmentId),
    );

    if (!attachment) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    let buffer: Buffer;
    try {
      buffer = await this.storageProvider.getObject(attachment.storageKey);
    } catch {
      // A missing object is an ordinary stale reference, and surfacing the
      // storage error would say more about the backend than a caller
      // should learn — the same reasoning `PublicMediaController` applies.
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    return {
      buffer,
      mimeType: attachment.mimeType,
      fileName: attachment.fileName,
    };
  }

  private async loadCaseOrThrow(
    tx: Parameters<SupportCasesRepository['findById']>[0],
    caseId: string,
  ) {
    const supportCase = await this.supportCasesRepository.findById(tx, caseId);
    if (!supportCase) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return supportCase;
  }
}
