/**
 * `SupportCaseSummary`/`.Detail`/`SupportCaseMessage` response contracts —
 * match `support.types.ts` (atlas frontend) field-for-field.
 */
import type { Organization, SupportCase, SupportCaseMessage } from '@prisma/client';

export type SupportCaseWithOrganization = SupportCase & {
  organization: Pick<Organization, 'id' | 'name'> | null;
};

export interface SupportCaseMessageResponse {
  readonly id: string;
  readonly authorName: string;
  readonly authorRole: SupportCaseMessage['authorRole'];
  readonly body: string;
  readonly createdAt: string;
}

export interface SupportCaseSummaryResponse {
  readonly id: string;
  readonly subject: string;
  readonly status: SupportCase['status'];
  readonly priority: SupportCase['priority'];
  readonly organizationId?: string;
  readonly organizationName?: string;
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
    requesterName: supportCase.requesterName,
    requesterEmail: supportCase.requesterEmail,
    assignedToName: supportCase.assignedToName ?? undefined,
    createdAt: supportCase.createdAt.toISOString(),
    updatedAt: supportCase.updatedAt.toISOString(),
  };
}

export function toSupportCaseMessageResponse(
  message: SupportCaseMessage,
): SupportCaseMessageResponse {
  return {
    id: message.id,
    authorName: message.authorName,
    authorRole: message.authorRole,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
  };
}

export function toSupportCaseDetailResponse(
  supportCase: SupportCaseWithOrganization,
  messages: readonly SupportCaseMessage[],
): SupportCaseDetailResponse {
  return {
    ...toSupportCaseSummaryResponse(supportCase),
    messages: messages.map(toSupportCaseMessageResponse),
  };
}
