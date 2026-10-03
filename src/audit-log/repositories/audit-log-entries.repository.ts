/**
 * AuditLogEntriesRepository — `audit_log_entries` is append-only,
 * Platform-owned, backend-sole-writer (master plan §5.12). Every READ
 * method takes a `Prisma.TransactionClient` from
 * `TenancyContextService.runInUserContext(platformOwnerId)` (the
 * `audit_log_entries_platform_select` RLS policy), matching every other
 * repository in this codebase's established rule. `create` is the one
 * exception — see its own doc comment for why it takes a raw
 * `Prisma.TransactionClient` from WHATEVER context the calling business
 * mutation already has open, never one this repository opens itself.
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { AuditLogEntryWithRelations } from '../dto/audit-log.contract';

const WITH_RELATIONS = {
  actor: { select: { id: true, name: true, email: true } },
  organization: { select: { id: true, name: true } },
  // P58 — the Academy relation. `academy_id` was already stored on every
  // Academy-scoped entry; without this include the response could only ever
  // carry the raw id, never a name an operator can read.
  academy: { select: { id: true, name: true } },
} as const;

export interface AuditLogEntryListFilter {
  readonly search?: string;
  readonly sortDirection?: 'asc' | 'desc';
  readonly skip: number;
  readonly take: number;
  /*
    P58 — typed filters.

    Every one of these is served by an index that already exists or was
    added in the P58 migration: `action` and `actorUserId` each have an
    `(column, occurred_at DESC)` index, `organizationId`/`academyId` had
    theirs since Phase 8, `targetType` is covered by
    `(target_type, target_id)`, and the date range walks
    `occurred_at DESC`. None of these is a sequential scan.

    Before this, the audit log accepted only the generic
    `CollectionQueryDto` — page/pageSize/sortBy/sortDirection/search — so
    "show me every plan pricing change" or "everything this operator did"
    could not be asked at all, despite the data and the indexes being
    present.
  */
  readonly action?: string;
  readonly actorUserId?: string;
  readonly targetType?: string;
  readonly organizationId?: string;
  readonly academyId?: string;
  readonly occurredFrom?: Date;
  readonly occurredTo?: Date;
}

/** Keyset position: the last row of the previous page, ordered `(occurred_at DESC, id DESC)`. */
export interface AuditLogCursor {
  readonly occurredAt: Date;
  readonly id: string;
}

/**
 * Cursor-paginated feed filter, shared by the Academy activity log (tenant
 * context) and the Platform audit feed (platform context). No `count()` is
 * ever run: the caller asks for `take + 1` rows and treats the extra one as
 * "there is a next page", which keeps every page an index range scan on
 * `(academy_id, occurred_at DESC)` / `(organization_id, occurred_at DESC)` /
 * `(occurred_at DESC)` regardless of how large the log grows.
 */
export interface AuditLogFeedFilter {
  readonly academyId?: string;
  readonly organizationId?: string;
  /** Restricts to these actions (the tenant visibility list, or a category's expansion). */
  readonly actions?: readonly string[];
  readonly actorUserId?: string;
  readonly targetType?: string;
  readonly occurredFrom?: Date;
  readonly occurredTo?: Date;
  /** Case-insensitive match on the target label or the actor's name. */
  readonly search?: string;
  readonly cursor?: AuditLogCursor;
  readonly take: number;
}

/** Names the formatter needs but older rows (and other modules' writes) only carry ids for. */
export interface AuditReferenceNames {
  readonly courses: ReadonlyMap<string, string>;
  readonly sections: ReadonlyMap<string, string>;
}

@Injectable()
export class AuditLogEntriesRepository {
  /** See `AuditLogFeedFilter`. Returns up to `take + 1` rows. */
  findFeedPage(
    tx: Prisma.TransactionClient,
    filter: AuditLogFeedFilter,
  ): Promise<AuditLogEntryWithRelations[]> {
    const conditions: Prisma.AuditLogEntryWhereInput[] = [];
    if (filter.academyId) conditions.push({ academyId: filter.academyId });
    if (filter.organizationId) conditions.push({ organizationId: filter.organizationId });
    if (filter.actions) conditions.push({ action: { in: [...filter.actions] } });
    if (filter.actorUserId) conditions.push({ actorUserId: filter.actorUserId });
    if (filter.targetType) conditions.push({ targetType: filter.targetType });
    if (filter.occurredFrom || filter.occurredTo) {
      conditions.push({
        occurredAt: {
          ...(filter.occurredFrom ? { gte: filter.occurredFrom } : {}),
          ...(filter.occurredTo ? { lte: filter.occurredTo } : {}),
        },
      });
    }
    if (filter.search) {
      conditions.push({
        OR: [
          { targetLabel: { contains: filter.search, mode: 'insensitive' as const } },
          { actor: { name: { contains: filter.search, mode: 'insensitive' as const } } },
        ],
      });
    }
    if (filter.cursor) {
      conditions.push({
        OR: [
          { occurredAt: { lt: filter.cursor.occurredAt } },
          { occurredAt: filter.cursor.occurredAt, id: { lt: filter.cursor.id } },
        ],
      });
    }

    return tx.auditLogEntry.findMany({
      where: conditions.length > 0 ? { AND: conditions } : {},
      include: WITH_RELATIONS,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: filter.take + 1,
    });
  }

  /** One entry by id, constrained by the same scope/visibility a feed would apply. */
  findScopedById(
    tx: Prisma.TransactionClient,
    id: string,
    scope: { readonly academyId: string; readonly actions: readonly string[] },
  ): Promise<AuditLogEntryWithRelations | null> {
    return tx.auditLogEntry.findFirst({
      where: { id, academyId: scope.academyId, action: { in: [...scope.actions] } },
      include: WITH_RELATIONS,
    });
  }

  /**
   * Batch-resolves course and section titles referenced by id in a page of
   * entries' `context` (two queries per page, never per row). Used only
   * when the row did not already store the name. Rows invisible to the
   * caller's RLS context — or deleted since — simply stay unresolved.
   */
  async loadReferenceNames(
    tx: Prisma.TransactionClient,
    entries: readonly { context: Prisma.JsonValue | null }[],
  ): Promise<AuditReferenceNames> {
    const courseIds = new Set<string>();
    const sectionIds = new Set<string>();
    for (const entry of entries) {
      const context = entry.context as Record<string, unknown> | null;
      if (!context) continue;
      if (
        typeof context.courseId === 'string' &&
        typeof context.courseTitle !== 'string'
      ) {
        courseIds.add(context.courseId);
      }
      if (
        typeof context.sectionId === 'string' &&
        typeof context.sectionTitle !== 'string'
      ) {
        sectionIds.add(context.sectionId);
      }
    }
    const [courses, sections] = await Promise.all([
      courseIds.size > 0
        ? tx.course.findMany({
            where: { id: { in: [...courseIds] } },
            select: { id: true, title: true },
          })
        : Promise.resolve([]),
      sectionIds.size > 0
        ? tx.courseSection.findMany({
            where: { id: { in: [...sectionIds] } },
            select: { id: true, title: true },
          })
        : Promise.resolve([]),
    ]);
    return {
      courses: new Map(courses.map((row) => [row.id, row.title])),
      sections: new Map(sections.map((row) => [row.id, row.title])),
    };
  }

  /**
   * The one write path for this table — see
   * `AuditLogWriterService`'s own doc comment for the atomicity
   * discipline this method exists to preserve: `tx` is ALWAYS the
   * caller's own already-open transaction (the same one committing the
   * audited business mutation), never a new one opened here. Relies on
   * this migration's deliberately permissive `audit_log_entries_insert`
   * (`WITH CHECK (true)`) RLS policy — see that policy's own inline
   * comment for why.
   *
   * Uses a raw, RETURNING-free `INSERT` (`$executeRaw`) rather than
   * `tx.auditLogEntry.create()` — a real bug, found and fixed while
   * building this exact method: Postgres RLS also filters a write's
   * implicit `RETURNING` clause through the table's own SELECT policies
   * (the identical "RLS filters RETURNING" lesson P13 already documented
   * at length in `Reports/ARCHITECTURE.md`), and `audit_log_entries_platform_select`
   * is deliberately gated to `is_platform_owner()` only — but most
   * callers of `write()` are NOT Platform Owners (a student buying a
   * course, an Organization owner creating an Academy, ...), so Prisma's
   * own `.create()` would fail on the implicit read-back even though the
   * INSERT itself is permitted. A raw `INSERT` with no `RETURNING` at all
   * has nothing for RLS to filter, sidestepping the conflict entirely
   * without widening the SELECT policy (which would defeat the whole
   * point of restricting general reads to Platform Owners). The id is
   * generated here, in application code, rather than relying on the
   * database default, precisely because there is no `RETURNING` to read
   * one back from.
   */
  async create(
    tx: Prisma.TransactionClient,
    data: Prisma.AuditLogEntryUncheckedCreateInput,
  ): Promise<{ id: string }> {
    const id = randomUUID();
    const actorUserId = data.actorUserId as string;
    const organizationId = (data.organizationId as string | undefined) ?? null;
    // Phase 8.
    const academyId = (data.academyId as string | undefined) ?? null;
    const role = (data.role as string | undefined) ?? null;
    const action = data.action as string;
    const targetType = data.targetType as string;
    const targetId = data.targetId as string;
    const targetLabel = (data.targetLabel as string | undefined) ?? null;
    const contextJson =
      data.context === undefined || data.context === null
        ? null
        : JSON.stringify(data.context);
    // P58 — structured before/after and request metadata. Same raw-INSERT
    // treatment as `context` for the same RLS-on-RETURNING reason above.
    const changesJson =
      data.changes === undefined || data.changes === null
        ? null
        : JSON.stringify(data.changes);
    const requestContextJson =
      data.requestContext === undefined || data.requestContext === null
        ? null
        : JSON.stringify(data.requestContext);

    await tx.$executeRaw`
      INSERT INTO "audit_log_entries"
        ("id", "actor_user_id", "organization_id", "academy_id", "role", "action", "target_type", "target_id", "target_label", "context", "changes", "request_context")
      VALUES (
        ${id},
        ${actorUserId},
        ${organizationId},
        ${academyId},
        ${role},
        ${action},
        ${targetType},
        ${targetId},
        ${targetLabel},
        ${contextJson}::jsonb,
        ${changesJson}::jsonb,
        ${requestContextJson}::jsonb
      )
    `;
    return { id };
  }

  async findMany(
    tx: Prisma.TransactionClient,
    filter: AuditLogEntryListFilter,
  ): Promise<{ items: AuditLogEntryWithRelations[]; totalItems: number }> {
    const conditions: Prisma.AuditLogEntryWhereInput[] = [];

    if (filter.search) {
      conditions.push({
        OR: [
          { action: { contains: filter.search, mode: 'insensitive' as const } },
          { targetLabel: { contains: filter.search, mode: 'insensitive' as const } },
          { targetType: { contains: filter.search, mode: 'insensitive' as const } },
          // P58 — searching by the affected entity's id is how an operator
          // actually traces "what happened to THIS thing".
          { targetId: { equals: filter.search } },
        ],
      });
    }
    // Exact-match filters, each backed by an index (see the filter type).
    if (filter.action) conditions.push({ action: filter.action });
    if (filter.actorUserId) conditions.push({ actorUserId: filter.actorUserId });
    if (filter.targetType) conditions.push({ targetType: filter.targetType });
    if (filter.organizationId) conditions.push({ organizationId: filter.organizationId });
    if (filter.academyId) conditions.push({ academyId: filter.academyId });
    if (filter.occurredFrom || filter.occurredTo) {
      conditions.push({
        occurredAt: {
          ...(filter.occurredFrom ? { gte: filter.occurredFrom } : {}),
          ...(filter.occurredTo ? { lte: filter.occurredTo } : {}),
        },
      });
    }

    const where: Prisma.AuditLogEntryWhereInput =
      conditions.length > 0 ? { AND: conditions } : {};

    const [items, totalItems] = await Promise.all([
      tx.auditLogEntry.findMany({
        where,
        include: WITH_RELATIONS,
        orderBy: { occurredAt: filter.sortDirection ?? 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      tx.auditLogEntry.count({ where }),
    ]);

    return { items, totalItems };
  }

  findById(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<AuditLogEntryWithRelations | null> {
    return tx.auditLogEntry.findUnique({ where: { id }, include: WITH_RELATIONS });
  }
}
