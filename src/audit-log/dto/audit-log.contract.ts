/**
 * `AuditLogEntrySummary`/`.Detail` response contracts — match
 * `audit-log.types.ts` (atlas frontend) field-for-field.
 */
import type { Academy, AuditLogEntry, Organization, User } from '@prisma/client';
import {
  getAuditEventDefinition,
  TENANT_HIDDEN_CONTEXT_KEYS,
  type AuditCategory,
} from '../catalog/audit-event-catalog';
import {
  containsEmail,
  maskEmailsInValue,
  stripEmails,
} from '../utils/audit-sanitize.util';
import type {
  AuditLogCursor,
  AuditReferenceNames,
} from '../repositories/audit-log-entries.repository';

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
  /** Task 3 — the catalogue category, `'other'` for an action written before the catalogue existed. */
  readonly category?: AuditCategory | 'other';
  /** Task 3 — the (already allowlisted) context, so a list row can render a full sentence without a detail fetch. */
  readonly context?: Record<string, string | number | boolean | null>;
  /** Task 3 — names of the fields in `changes`, so a row can say "changed title and price" without carrying values. */
  readonly changedFields?: readonly string[];
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

type AuditContextRecord = Record<string, string | number | boolean | null>;

/**
 * Adds `courseTitle`/`sectionTitle` from the page-level batch lookup when the
 * row only stored ids. A name stored at write time always wins — it is what
 * the thing was called WHEN it happened.
 */
export function enrichAuditContext(
  context: AuditLogEntry['context'],
  names?: AuditReferenceNames,
): AuditContextRecord | undefined {
  const base = (context as AuditContextRecord | null) ?? undefined;
  if (!base || !names) return base;
  const out: AuditContextRecord = { ...base };
  if (typeof base.courseId === 'string' && typeof base.courseTitle !== 'string') {
    const title = names.courses.get(base.courseId);
    if (title) out.courseTitle = title;
  }
  if (typeof base.sectionId === 'string' && typeof base.sectionTitle !== 'string') {
    const title = names.sections.get(base.sectionId);
    if (title) out.sectionTitle = title;
  }
  return out;
}

function changedFieldsOf(entry: AuditLogEntry): readonly string[] | undefined {
  const changes = entry.changes as Record<string, unknown> | null;
  if (!changes) return undefined;
  const fields = Object.keys(changes);
  return fields.length > 0 ? fields : undefined;
}

function categoryOf(action: string): AuditCategory | 'other' {
  return getAuditEventDefinition(action)?.category ?? 'other';
}

export function toAuditLogEntrySummaryResponse(
  entry: AuditLogEntryWithRelations,
  names?: AuditReferenceNames,
): AuditLogEntrySummaryResponse {
  return {
    ...toAuditLogEntryBaseSummary(entry),
    category: categoryOf(entry.action),
    context: enrichAuditContext(entry.context, names),
    changedFields: changedFieldsOf(entry),
  };
}

function toAuditLogEntryBaseSummary(
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
  names?: AuditReferenceNames,
): AuditLogEntryDetailResponse {
  return {
    ...toAuditLogEntrySummaryResponse(entry, names),
    changes:
      (entry.changes as Record<string, { from: unknown; to: unknown }> | null) ??
      undefined,
    requestContext: (entry.requestContext as Record<string, unknown> | null) ?? undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Task 3 — cursor feeds (Academy activity log + Platform audit feed)  */
/* ------------------------------------------------------------------ */

/** `{ items, nextCursor }` — no total, by design (see `AuditLogFeedFilter`). */
export interface AuditLogCursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** Opaque to clients: base64url of `<occurredAt ISO>|<id>`. */
export function encodeAuditCursor(cursor: AuditLogCursor): string {
  return Buffer.from(`${cursor.occurredAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `undefined` for anything that is not a cursor this API issued — the caller answers 400. */
export function decodeAuditCursor(raw: string): AuditLogCursor | undefined {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  const separator = decoded.indexOf('|');
  if (separator < 0) return undefined;
  const occurredAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(occurredAt.getTime()) || !UUID_PATTERN.test(id)) return undefined;
  return { occurredAt, id };
}

/** Splits a `take + 1` result into the page and its next cursor. */
export function toCursorPage<T>(
  rows: readonly AuditLogEntryWithRelations[],
  take: number,
  map: (row: AuditLogEntryWithRelations) => T,
): AuditLogCursorPage<T> {
  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  return {
    items: page.map(map),
    nextCursor:
      rows.length > take && last
        ? encodeAuditCursor({ occurredAt: last.occurredAt, id: last.id })
        : null,
  };
}

/**
 * What an Academy/Organization owner sees. Differs from the Platform shape
 * on purpose:
 *   - the actor carries a NAME only, never an email;
 *   - an action performed by Atlas staff (`role = 'platform_owner'`) is
 *     attributed to "Atlas" rather than to a named operator;
 *   - a legacy row whose label still holds an email (written before the
 *     catalogue) has the address stripped on the way out.
 */
export interface TenantAuditLogActorResponse {
  readonly id: string;
  readonly name: string;
  readonly isPlatformStaff: boolean;
}

export interface TenantAuditLogEntryResponse {
  readonly id: string;
  readonly action: string;
  readonly category: AuditCategory | 'other';
  readonly targetType: string;
  readonly targetId: string;
  readonly targetLabel?: string;
  readonly actor: TenantAuditLogActorResponse;
  readonly role?: string;
  readonly academyId?: string;
  readonly academyName?: string;
  readonly occurredAt: string;
  readonly context?: AuditContextRecord;
  readonly changedFields?: readonly string[];
}

export interface TenantAuditLogEntryDetailResponse extends TenantAuditLogEntryResponse {
  readonly changes?: Record<string, { from: unknown; to: unknown }>;
}

function tenantSafeLabel(label: string | null): string | undefined {
  if (!label) return undefined;
  return containsEmail(label) ? stripEmails(label) : label;
}

function tenantSafeContext(
  context: AuditContextRecord | undefined,
): AuditContextRecord | undefined {
  if (!context) return undefined;
  const out: AuditContextRecord = {};
  for (const [key, value] of Object.entries(context)) {
    if (TENANT_HIDDEN_CONTEXT_KEYS.has(key) || /(^ip$|ipaddress|ip_address)/i.test(key)) {
      continue;
    }
    if (typeof value === 'string' && containsEmail(value)) {
      const stripped = stripEmails(value);
      if (stripped) out[key] = stripped;
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function toTenantAuditLogEntryResponse(
  entry: AuditLogEntryWithRelations,
  names?: AuditReferenceNames,
): TenantAuditLogEntryResponse {
  const isPlatformStaff = entry.role === 'platform_owner';
  return {
    id: entry.id,
    action: entry.action,
    category: categoryOf(entry.action),
    targetType: entry.targetType,
    targetId: entry.targetId,
    targetLabel: tenantSafeLabel(entry.targetLabel),
    actor: {
      id: isPlatformStaff ? 'atlas' : entry.actor.id,
      name: isPlatformStaff ? 'Atlas' : entry.actor.name,
      isPlatformStaff,
    },
    role: entry.role ?? undefined,
    academyId: entry.academyId ?? undefined,
    academyName: entry.academy?.name ?? undefined,
    occurredAt: entry.occurredAt.toISOString(),
    context: tenantSafeContext(enrichAuditContext(entry.context, names)),
    changedFields: changedFieldsOf(entry),
  };
}

export function toTenantAuditLogEntryDetailResponse(
  entry: AuditLogEntryWithRelations,
  names?: AuditReferenceNames,
): TenantAuditLogEntryDetailResponse {
  return {
    ...toTenantAuditLogEntryResponse(entry, names),
    changes: entry.changes
      ? Object.fromEntries(
          Object.entries(
            entry.changes as Record<string, { from: unknown; to: unknown }>,
          ).map(([field, change]) => [
            field,
            { from: maskEmailsInValue(change.from), to: maskEmailsInValue(change.to) },
          ]),
        )
      : undefined,
  };
}
