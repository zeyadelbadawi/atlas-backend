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
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { SupportCasesRepository } from '../repositories/support-cases.repository';
import { SupportCaseMessagesRepository } from '../repositories/support-case-messages.repository';
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
import type { ListSupportCasesQueryDto } from '../dto/list-support-cases-query.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';

@Injectable()
export class SupportCasesService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly supportCasesRepository: SupportCasesRepository,
    private readonly supportCaseMessagesRepository: SupportCaseMessagesRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly notificationFanoutService: NotificationFanoutService,
  ) {}

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
      return toSupportCaseDetailResponse(supportCase, messages);
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
      return toSupportCaseDetailResponse(updated, messages);
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
        return toSupportCaseDetailResponse(touched, messages);
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
