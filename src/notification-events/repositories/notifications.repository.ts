/**
 * NotificationsRepository — the `notifications` data-access layer (master
 * plan §21 Phase P17). Every method takes the caller's own
 * `Prisma.TransactionClient`, matching every other tenant/self-scoped
 * repository in this codebase.
 *
 * Read/mark-read methods are called under
 * `TenancyContextService.runInUserContext(recipientUserId)` — the
 * recipient reading/mutating their OWN rows, so `notifications_self_
 * select`/`notifications_self_update`'s RLS session context IS the row
 * owner, and a normal Prisma `.update()`'s implicit `RETURNING` works
 * without hitting the "RLS filters RETURNING through the table's own
 * SELECT policy" bug class P15 first discovered (`AuditLogEntriesRepository`'s
 * own doc comment) — that bug only bites when the ACTING session context
 * differs from the row being written, which never happens here.
 *
 * `create`, by contrast, is called by a business-process service acting on
 * behalf of ANOTHER user (the notification's recipient) — the acting
 * session context is NOT the recipient, so `notifications_self_select`
 * would filter out a `RETURNING` clause even though the `notifications_
 * system_insert` policy's unconditional `WITH CHECK (true)` lets the
 * INSERT itself succeed. `create` reuses the raw-`$executeRaw`-INSERT-
 * with-no-RETURNING technique `AuditLogEntriesRepository.create`
 * established for that first reason.
 *
 * A SECOND, real bug was found (and is why this method does NOT use
 * `INSERT ... ON CONFLICT ("user_id", "dedupe_key") DO NOTHING`, despite
 * that being the obvious way to express the dedupe rule): PostgreSQL's
 * `ON CONFLICT` conflict-detection mechanism implicitly requires the
 * table's SELECT policy to also permit seeing the (would-be) conflicting
 * row — under `FORCE ROW LEVEL SECURITY`, this raises the SAME "new row
 * violates row-level security policy" error even though the INSERT's own
 * `WITH CHECK (true)` is satisfied, whenever the row's `user_id` differs
 * from the acting session's `app.current_user_id` (i.e. on every REAL
 * call site in this phase — a business-process service almost always
 * notifies someone OTHER than the acting user). Reproduced directly
 * against Postgres, isolated from any application code, before this fix.
 * The fix: a plain `INSERT` with no `ON CONFLICT` clause, relying on the
 * real `@@unique([userId, dedupeKey])` constraint to reject a genuine
 * duplicate — caught here as a `P2002` (`23505`) unique-violation error
 * and treated as "not newly created," mirroring
 * `CourseOrderRefundsService`'s own established
 * `isUniqueConstraintViolation` catch-and-recover pattern (P13) exactly,
 * rather than inventing a second idempotency mechanism.
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Notification } from '@prisma/client';

/**
 * `CourseOrderRefundsService`'s own identical-in-spirit helper (P13)
 * checks `error.code === 'P2002'` — but that mapping is specific to
 * Prisma's QUERY-BUILDER methods (`.create()`/`.update()`). This class's
 * `create` uses `$executeRaw` (a real, database-level RAW query) instead
 * — for those, Prisma reports the generic `P2010` ("raw query failed")
 * and nests the REAL Postgres error code at `error.meta.code` instead
 * (verified directly: `23505` there, not `P2002` at the top level).
 * Checking both keeps this helper correct for either call shape without
 * ever needing to know in advance which one produced the error.
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2002') return true;
  const meta = error.meta as { code?: string } | undefined;
  return meta?.code === '23505';
}

export interface NotificationListFilter {
  readonly isRead?: boolean;
  readonly type?: string;
  readonly priority?: string;
  readonly skip: number;
  readonly take: number;
  readonly sortDirection: 'asc' | 'desc';
}

export interface CreateNotificationInput {
  readonly userId: string;
  readonly type: string;
  readonly priority: string;
  readonly titleKey: string;
  readonly messageKey: string;
  readonly values?: Record<string, unknown>;
  readonly actionUrl?: string;
  readonly actionLabelKey?: string;
  readonly metadata?: Record<string, unknown>;
  /** Null/omitted = never deduped (see schema.prisma's own doc comment on this table). */
  readonly dedupeKey?: string | null;
}

@Injectable()
export class NotificationsRepository {
  async findMany(
    tx: Prisma.TransactionClient,
    userId: string,
    filter: NotificationListFilter,
  ): Promise<{ items: Notification[]; totalItems: number }> {
    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(filter.isRead !== undefined ? { isRead: filter.isRead } : {}),
      ...(filter.type ? { type: filter.type as Prisma.EnumNotificationTypeFilter } : {}),
      ...(filter.priority
        ? { priority: filter.priority as Prisma.EnumNotificationPriorityFilter }
        : {}),
    };

    const [items, totalItems] = await Promise.all([
      tx.notification.findMany({
        where,
        orderBy: { createdAt: filter.sortDirection },
        skip: filter.skip,
        take: filter.take,
      }),
      tx.notification.count({ where }),
    ]);

    return { items, totalItems };
  }

  findById(tx: Prisma.TransactionClient, id: string): Promise<Notification | null> {
    return tx.notification.findUnique({ where: { id } });
  }

  /** Scoped by BOTH `id` and `userId` in the query itself — never relies on RLS alone to prevent one user from marking another's notification read (master plan §18's "authorization must exist in the service/repository query path too," not just the guard). */
  markAsRead(
    tx: Prisma.TransactionClient,
    userId: string,
    id: string,
  ): Promise<Notification | null> {
    return tx.notification
      .updateMany({ where: { id, userId }, data: { isRead: true } })
      .then(async (result) =>
        result.count === 0 ? null : tx.notification.findUnique({ where: { id } }),
      );
  }

  async markAllAsRead(tx: Prisma.TransactionClient, userId: string): Promise<number> {
    const result = await tx.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
    return result.count;
  }

  async getSummary(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<{
    total: number;
    unread: number;
    byType: { type: string; count: number }[];
    byPriority: { priority: string; count: number }[];
  }> {
    const [total, unread, byType, byPriority] = await Promise.all([
      tx.notification.count({ where: { userId } }),
      tx.notification.count({ where: { userId, isRead: false } }),
      tx.notification.groupBy({ by: ['type'], where: { userId }, _count: true }),
      tx.notification.groupBy({ by: ['priority'], where: { userId }, _count: true }),
    ]);

    return {
      total,
      unread,
      byType: byType.map((r) => ({ type: r.type, count: r._count })),
      byPriority: byPriority.map((r) => ({ priority: r.priority, count: r._count })),
    };
  }

  /**
   * Returns `true` if a NEW row was actually inserted, `false` if it was a
   * dedupe no-op (a real `P2002` unique-constraint violation on
   * `(user_id, dedupe_key)`, caught and swallowed) — the caller
   * (`NotificationFanoutService`) uses this to decide whether to also send
   * an email (never re-emailing on a deduped retry). No `ON CONFLICT`
   * clause — see this class's own header comment for the real RLS bug
   * that requires avoiding it.
   */
  async create(
    tx: Prisma.TransactionClient,
    input: CreateNotificationInput,
  ): Promise<boolean> {
    const id = randomUUID();
    const valuesJson = input.values === undefined ? null : JSON.stringify(input.values);
    const metadataJson =
      input.metadata === undefined ? null : JSON.stringify(input.metadata);
    const dedupeKey = input.dedupeKey ?? null;

    // `updated_at` has no DB-level default — Prisma's `@updatedAt` is
    // normally populated by Prisma CLIENT itself on every `.create()`/
    // `.update()` call, which this raw `$executeRaw` INSERT deliberately
    // bypasses (see this class's own header comment) — so it must be set
    // explicitly here, exactly like `created_at` (which DOES have a
    // `DEFAULT now()` from the migration, but is set explicitly anyway
    // for clarity/consistency with `updated_at`).
    const now = new Date();
    try {
      await tx.$executeRaw`
        INSERT INTO "notifications"
          ("id", "user_id", "type", "priority", "title_key", "message_key", "values",
           "action_url", "action_label_key", "metadata", "dedupe_key", "created_at", "updated_at")
        VALUES (
          ${id}, ${input.userId}, ${input.type}::"notification_type", ${input.priority}::"notification_priority",
          ${input.titleKey}, ${input.messageKey}, ${valuesJson}::jsonb,
          ${input.actionUrl ?? null}, ${input.actionLabelKey ?? null}, ${metadataJson}::jsonb, ${dedupeKey},
          ${now}, ${now}
        )
      `;
      return true;
    } catch (error) {
      if (isUniqueConstraintViolation(error)) return false;
      throw error;
    }
  }
}
