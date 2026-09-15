/**
 * SupportCaseMessageAttachmentsRepository — see `SupportCasesRepository`'s
 * doc comment for the shared RLS/context rule: every method takes the
 * caller's transaction client so the row-level policies established by
 * `runInUserContext` are the thing that actually decides visibility.
 *
 * `findByIdWithMessage` is the read the authenticated download route uses.
 * It applies NO ownership predicate of its own, deliberately — the
 * `support_case_message_attachments_requester_select` /
 * `_platform_select` policies are the authorization, and adding a
 * duplicate WHERE clause here would create a second, weaker place for that
 * rule to drift from. An attachment belonging to somebody else's ticket
 * simply does not exist on this connection.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, SupportCaseMessageAttachment } from '@prisma/client';

export type SupportCaseMessageAttachmentWithMessage = SupportCaseMessageAttachment & {
  message: { id: string; caseId: string };
};

@Injectable()
export class SupportCaseMessageAttachmentsRepository {
  create(
    tx: Prisma.TransactionClient,
    data: Prisma.SupportCaseMessageAttachmentUncheckedCreateInput,
  ): Promise<SupportCaseMessageAttachment> {
    return tx.supportCaseMessageAttachment.create({ data });
  }

  findManyForMessages(
    tx: Prisma.TransactionClient,
    messageIds: readonly string[],
  ): Promise<SupportCaseMessageAttachment[]> {
    if (messageIds.length === 0) return Promise.resolve([]);
    return tx.supportCaseMessageAttachment.findMany({
      where: { messageId: { in: [...messageIds] } },
      orderBy: { createdAt: 'asc' },
    });
  }

  findByIdWithMessage(
    tx: Prisma.TransactionClient,
    attachmentId: string,
  ): Promise<SupportCaseMessageAttachmentWithMessage | null> {
    return tx.supportCaseMessageAttachment.findUnique({
      where: { id: attachmentId },
      include: { message: { select: { id: true, caseId: true } } },
    });
  }
}
