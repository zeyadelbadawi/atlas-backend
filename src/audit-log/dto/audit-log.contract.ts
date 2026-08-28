/**
 * `AuditLogEntrySummary`/`.Detail` response contracts — match
 * `audit-log.types.ts` (atlas frontend) field-for-field.
 */
import type { AuditLogEntry, Organization, User } from '@prisma/client';

export type AuditLogEntryWithRelations = AuditLogEntry & {
  actor: Pick<User, 'id' | 'name' | 'email'>;
  organization: Pick<Organization, 'id' | 'name'> | null;
};

export interface AuditLogActorResponse {
  readonly id: string;
  readonly name: string;
  readonly email?: string;
}

export interface AuditLogEntrySummaryResponse {
  readonly id: string;
  readonly actor: AuditLogActorResponse;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly targetLabel?: string;
  readonly organizationId?: string;
  readonly organizationName?: string;
  readonly occurredAt: string;
}

export interface AuditLogEntryDetailResponse extends AuditLogEntrySummaryResponse {
  readonly context?: Record<string, string | number | boolean | null>;
}

export function toAuditLogEntrySummaryResponse(
  entry: AuditLogEntryWithRelations,
): AuditLogEntrySummaryResponse {
  return {
    id: entry.id,
    actor: { id: entry.actor.id, name: entry.actor.name, email: entry.actor.email },
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    targetLabel: entry.targetLabel ?? undefined,
    organizationId: entry.organization?.id,
    organizationName: entry.organization?.name,
    occurredAt: entry.occurredAt.toISOString(),
  };
}

export function toAuditLogEntryDetailResponse(
  entry: AuditLogEntryWithRelations,
): AuditLogEntryDetailResponse {
  return {
    ...toAuditLogEntrySummaryResponse(entry),
    context:
      (entry.context as Record<string, string | number | boolean | null> | null) ??
      undefined,
  };
}
