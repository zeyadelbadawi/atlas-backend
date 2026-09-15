/**
 * `SupportCaseSummary`/`.Detail`/`SupportCaseMessage` response contracts —
 * match `support.types.ts` (atlas frontend) field-for-field.
 */
import type {
  Organization,
  SupportCase,
  SupportCaseMessage,
  SupportCaseMessageAttachment,
} from '@prisma/client';

export type SupportCaseWithOrganization = SupportCase & {
  organization: Pick<Organization, 'id' | 'name'> | null;
};

/**
 * P53 — one image attached to a message.
 *
 * `url` IS A RELATIVE ATLAS PATH, never an object-storage URL. That is the
 * same rule `media_assets.url` follows (`PublicMediaController`'s own
 * header: Atlas serves its own bytes), for the same reasons — no dependency
 * on out-of-band bucket configuration, and no R2 account hash in a
 * customer's HTML. The difference is only WHO may fetch it: this path is
 * authenticated and RLS-scoped, because a ticket is private to the person
 * who filed it.
 *
 * `storageKey` is deliberately NOT exposed. The client addresses an
 * attachment by its row id and nothing else, so no part of the object
 * namespace is ever a client-side value.
 */
export interface SupportCaseAttachmentResponse {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly createdAt: string;
}

export interface SupportCaseMessageResponse {
  readonly id: string;
  readonly authorName: string;
  readonly authorRole: SupportCaseMessage['authorRole'];
  readonly body: string;
  readonly createdAt: string;
  /** P53 — empty for every message filed before attachments existed, and for any text-only message. */
  readonly attachments: readonly SupportCaseAttachmentResponse[];
}

export function toSupportCaseAttachmentResponse(
  attachment: SupportCaseMessageAttachment,
): SupportCaseAttachmentResponse {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    // `bigint` at rest (a real file size), `number` on the wire — the same
    // narrowing `toMediaAssetResponse` already performs for `sizeBytes`.
    sizeBytes: Number(attachment.sizeBytes),
    url: `/support-cases/attachments/${attachment.id}`,
    createdAt: attachment.createdAt.toISOString(),
  };
}

export interface SupportCaseSummaryResponse {
  readonly id: string;
  readonly subject: string;
  readonly status: SupportCase['status'];
  readonly priority: SupportCase['priority'];
  readonly organizationId?: string;
  readonly organizationName?: string;
  /** Phase 8 — set only for a ticket scoped to one Academy. */
  readonly academyId?: string;
  readonly requesterName: string;
  readonly requesterEmail: string;
  readonly assignedToName?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SupportCaseDetailResponse extends SupportCaseSummaryResponse {
  readonly messages: readonly SupportCaseMessageResponse[];
}

export function toSupportCaseSummaryResponse(
  supportCase: SupportCaseWithOrganization,
): SupportCaseSummaryResponse {
  return {
    id: supportCase.id,
    subject: supportCase.subject,
    status: supportCase.status,
    priority: supportCase.priority,
    organizationId: supportCase.organization?.id,
    organizationName: supportCase.organization?.name,
    academyId: supportCase.academyId ?? undefined,
    requesterName: supportCase.requesterName,
    requesterEmail: supportCase.requesterEmail,
    assignedToName: supportCase.assignedToName ?? undefined,
    createdAt: supportCase.createdAt.toISOString(),
    updatedAt: supportCase.updatedAt.toISOString(),
  };
}

export function toSupportCaseMessageResponse(
  message: SupportCaseMessage,
  attachments: readonly SupportCaseMessageAttachment[] = [],
): SupportCaseMessageResponse {
  return {
    id: message.id,
    authorName: message.authorName,
    authorRole: message.authorRole,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    attachments: attachments.map(toSupportCaseAttachmentResponse),
  };
}

export function toSupportCaseDetailResponse(
  supportCase: SupportCaseWithOrganization,
  messages: readonly SupportCaseMessage[],
  /**
   * Every attachment on this case's thread, in one list. Grouped here
   * rather than fetched per message so a thread costs one query regardless
   * of how long it is — the caller reads them under its own RLS context,
   * so a message whose attachment the caller may not see simply arrives
   * without one.
   */
  attachments: readonly SupportCaseMessageAttachment[] = [],
): SupportCaseDetailResponse {
  const byMessageId = new Map<string, SupportCaseMessageAttachment[]>();
  for (const attachment of attachments) {
    const existing = byMessageId.get(attachment.messageId);
    if (existing) existing.push(attachment);
    else byMessageId.set(attachment.messageId, [attachment]);
  }

  return {
    ...toSupportCaseSummaryResponse(supportCase),
    messages: messages.map((message) =>
      toSupportCaseMessageResponse(message, byMessageId.get(message.id) ?? []),
    ),
  };
}
