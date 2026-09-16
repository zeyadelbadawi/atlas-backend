/**
 * `AuditLogEntrySummary`/`.Detail` response contracts — match
 * `audit-log.types.ts` (atlas frontend) field-for-field.
 */
import type { Academy, AuditLogEntry, Organization, User } from '@prisma/client';

export type AuditLogEntryWithRelations = AuditLogEntry & {
  actor: Pick<User, 'id' | 'name' | 'email'>;
  organization: Pick<Organization, 'id' | 'name'> | null;
  /** P58 — the Academy was always stored on the row; it was simply never returned. */
  academy?: Pick<Academy, 'id' | 'name'> | null;
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
  /**
   * P58 — WHICH ACADEMY. `audit_log_entries.academy_id` has been populated
   * since Phase 8 for every Academy-scoped mutation, and was absent from
   * both response shapes — so "which Academy was involved" was already in
   * the database and simply never sent. No migration was needed to answer
   * it; this is presentation catching up with storage.
   */
  readonly academyId?: string;
  readonly academyName?: string;
  /** P58 — the actor's role AT THE TIME of the action. Stored since Phase 8, likewise never returned. */
  readonly role?: string;
  readonly occurredAt: string;
}

export interface AuditLogEntryDetailResponse extends AuditLogEntrySummaryResponse {
  readonly context?: Record<string, string | number | boolean | null>;
  /**
   * P58 — structured before/after, already redacted at WRITE time by
   * `AuditLogWriterService.redactChanges`. Absent for every entry written
   * before P58 and for any mutation with no recorded diff; the UI reports
   * that honestly rather than implying nothing changed.
   */
  readonly changes?: Record<string, { from: unknown; to: unknown }>;
  /** P58 — non-identifying request metadata. Never headers, bodies or tokens. */
  readonly requestContext?: Record<string, unknown>;
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
    academyId: entry.academyId ?? undefined,
    academyName: entry.academy?.name ?? undefined,
    role: entry.role ?? undefined,
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
    changes:
      (entry.changes as Record<string, { from: unknown; to: unknown }> | null) ??
      undefined,
    requestContext:
      (entry.requestContext as Record<string, unknown> | null) ?? undefined,
  };
}
