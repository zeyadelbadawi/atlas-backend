/**
 * AcademyEmailActivityService — W3: the Platform Owner's per-academy view of
 * what Atlas emailed, and what became of it.
 *
 * TWO GATES. The controller admits only the Platform Owner
 * (`PlatformOwnerGuard` on a management session); every read here then runs
 * under that CALLER's own user context, so `communication_outbox_platform_select`
 * and `communication_deliveries_platform_select` prove the same thing again,
 * independently (the `PlatformCommunicationsHealthService` rule).
 *
 * WHAT NEVER LEAVES. The SELECT lists names its columns explicitly and
 * `values` is not among them — it can hold link tokens before settle,
 * third-party personal values and (for rows written before the W3 fix)
 * emailed codes. No subject or body exists in the outbox at all. The
 * recipient is shown masked (`a•••@domain`), and raw provider/MTA error text
 * is replaced by a closed category (`categorizeEmailError`).
 *
 * INDEX. Filtered to one academy, the list is a keyset walk of
 * `communication_outbox_academy_id_created_at_id_idx`
 * (`academy_id, created_at DESC, id DESC WHERE academy_id IS NOT NULL`).
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { maskEmail } from '../../identity/services/email-otp.service';
import type { AcademyEmailActivityQueryDto } from '../dto/academy-email-activity.dto';
import type {
  EmailActivityAcademySummary,
  EmailActivityItem,
  EmailActivityPage,
  EmailActivitySummary,
} from '../dto/academy-email-activity.contract';
import {
  EMAIL_ACTIVITY_STATUSES,
  EMAIL_ACTIVITY_STATUS_SQL,
  SECURITY_EMAIL_KEYS,
  categorizeEmailError,
  type EmailActivityStatus,
} from '../utils/email-activity-status.util';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The outbox's own retention: nothing older exists to show. */
const MAX_WINDOW_DAYS = 90;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_LIMIT = 25;
const TOP_ACADEMIES = 20;

interface ActivityRow {
  readonly id: string;
  readonly key: string;
  readonly category: string;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly locale: string;
  readonly created_at: Date;
  readonly dispatched_at: Date | null;
  readonly academy_id: string;
  readonly recipient_user_id: string | null;
  readonly provider: string | null;
  readonly delivery_status: string | null;
  readonly delivery_error_code: string | null;
  readonly delivery_updated_at: Date | null;
  readonly ui_status: EmailActivityStatus;
}

interface Window {
  readonly from: Date;
  readonly to: Date;
}

function zeroedStatuses(): Record<EmailActivityStatus, number> {
  return Object.fromEntries(EMAIL_ACTIVITY_STATUSES.map((s) => [s, 0])) as Record<
    EmailActivityStatus,
    number
  >;
}

export function encodeActivityCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeActivityCursor(
  cursor: string,
): { readonly createdAt: Date; readonly id: string } | null {
  try {
    const [iso, id, ...rest] = Buffer.from(cursor, 'base64url')
      .toString('utf8')
      .split('|');
    if (rest.length || !iso || !id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const createdAt = new Date(iso);
    return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
  } catch {
    return null;
  }
}

/** Resolves and bounds the query window; refuses an inverted or over-long one. */
export function resolveActivityWindow(
  query: Pick<AcademyEmailActivityQueryDto, 'from' | 'to'>,
  now: Date = new Date(),
): Window {
  const to = query.to ? new Date(query.to) : now;
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  if (from.getTime() >= to.getTime()) {
    throw new BadRequestException({ messageKey: 'errors.validation.failed' });
  }
  const earliest = new Date(now.getTime() - MAX_WINDOW_DAYS * DAY_MS);
  return { from: from < earliest ? earliest : from, to };
}

@Injectable()
export class AcademyEmailActivityService {
  constructor(private readonly tenancyContextService: TenancyContextService) {}

  async list(
    platformOwnerUserId: string,
    query: AcademyEmailActivityQueryDto,
  ): Promise<EmailActivityPage> {
    const window = resolveActivityWindow(query);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const cursor = query.cursor ? decodeActivityCursor(query.cursor) : null;
    if (query.cursor && !cursor) {
      throw new BadRequestException({ messageKey: 'errors.validation.failed' });
    }

    const conditions: Prisma.Sql[] = [
      query.academyId
        ? Prisma.sql`o."academy_id" = ${query.academyId}`
        : Prisma.sql`o."academy_id" IS NOT NULL`,
      Prisma.sql`o."created_at" >= ${window.from}`,
      Prisma.sql`o."created_at" < ${window.to}`,
    ];
    if (query.key) conditions.push(Prisma.sql`o."key" = ${query.key}`);
    if (cursor) {
      conditions.push(
        Prisma.sql`(o."created_at", o."id") < (${cursor.createdAt}, ${cursor.id})`,
      );
    }
    const statusFilter = query.status
      ? Prisma.sql`WHERE activity."ui_status" = ${query.status}`
      : Prisma.empty;

    const { rows, users, academies } = await this.tenancyContextService.runInUserContext(
      platformOwnerUserId,
      async (tx) => {
        const rows = await tx.$queryRaw<ActivityRow[]>`
          SELECT * FROM (
            SELECT o."id", o."key", o."category"::text AS "category", o."attempts",
                   o."last_error", o."locale", o."created_at", o."dispatched_at",
                   o."academy_id", o."recipient_user_id",
                   d."provider", d."status"::text AS "delivery_status",
                   d."error_code" AS "delivery_error_code",
                   d."updated_at" AS "delivery_updated_at",
                   ${Prisma.raw(EMAIL_ACTIVITY_STATUS_SQL)} AS "ui_status"
              FROM "communication_outbox" o
              LEFT JOIN LATERAL (
                SELECT dd."provider", dd."status", dd."error_code", dd."updated_at"
                  FROM "communication_deliveries" dd
                 WHERE dd."outbox_id" = o."id" AND dd."channel" = 'email'
                 ORDER BY dd."created_at" DESC
                 LIMIT 1
              ) d ON true
             WHERE ${Prisma.join(conditions, ' AND ')}
             ORDER BY o."created_at" DESC, o."id" DESC
          ) activity
          ${statusFilter}
          ORDER BY activity."created_at" DESC, activity."id" DESC
          LIMIT ${limit + 1}
        `;
        const page = rows.slice(0, limit);
        const userIds = [
          ...new Set(
            page.map((r) => r.recipient_user_id).filter((v): v is string => !!v),
          ),
        ];
        const academyIds = [...new Set(page.map((r) => r.academy_id))];
        const users = userIds.length
          ? await tx.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, email: true },
            })
          : [];
        const academies = academyIds.length
          ? await tx.academy.findMany({
              where: { id: { in: academyIds } },
              select: { id: true, name: true },
            })
          : [];
        return { rows, users, academies };
      },
    );

    const emailById = new Map(users.map((u) => [u.id, u.email]));
    const nameById = new Map(academies.map((a) => [a.id, a.name]));
    const page = rows.slice(0, limit);
    const items: EmailActivityItem[] = page.map((row) => {
      const email = row.recipient_user_id
        ? emailById.get(row.recipient_user_id)
        : undefined;
      return {
        id: row.id,
        key: row.key,
        category: row.category,
        security: SECURITY_EMAIL_KEYS.has(row.key),
        status: row.ui_status,
        deliveryStatus: row.delivery_status,
        provider: row.provider,
        errorCategory: categorizeEmailError({
          lastError: row.last_error,
          deliveryStatus: row.delivery_status,
          deliveryErrorCode: row.delivery_error_code,
        }),
        recipient: { maskedEmail: email ? maskEmail(email) : null },
        academy: { id: row.academy_id, name: nameById.get(row.academy_id) ?? null },
        locale: row.locale,
        attempts: row.attempts,
        createdAt: row.created_at.toISOString(),
        dispatchedAt: row.dispatched_at?.toISOString() ?? null,
        deliveryUpdatedAt: row.delivery_updated_at?.toISOString() ?? null,
      };
    });
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeActivityCursor(last.created_at, last.id)
          : null,
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
    };
  }

  async summary(
    platformOwnerUserId: string,
    query: Pick<AcademyEmailActivityQueryDto, 'academyId' | 'from' | 'to' | 'key'>,
  ): Promise<EmailActivitySummary> {
    const window = resolveActivityWindow(query);
    const conditions: Prisma.Sql[] = [
      query.academyId
        ? Prisma.sql`o."academy_id" = ${query.academyId}`
        : Prisma.sql`o."academy_id" IS NOT NULL`,
      Prisma.sql`o."created_at" >= ${window.from}`,
      Prisma.sql`o."created_at" < ${window.to}`,
    ];
    if (query.key) conditions.push(Prisma.sql`o."key" = ${query.key}`);

    const { grouped, academies, webhooks } =
      await this.tenancyContextService.runInUserContext(
        platformOwnerUserId,
        async (tx) => {
          const grouped = await tx.$queryRaw<
            { academy_id: string; ui_status: EmailActivityStatus; n: number }[]
          >`
          SELECT o."academy_id", ${Prisma.raw(EMAIL_ACTIVITY_STATUS_SQL)} AS "ui_status",
                 count(*)::int AS "n"
            FROM "communication_outbox" o
            LEFT JOIN LATERAL (
              SELECT dd."status"
                FROM "communication_deliveries" dd
               WHERE dd."outbox_id" = o."id" AND dd."channel" = 'email'
               ORDER BY dd."created_at" DESC
               LIMIT 1
            ) d ON true
           WHERE ${Prisma.join(conditions, ' AND ')}
           GROUP BY 1, 2
        `;
          const academyIds = [...new Set(grouped.map((g) => g.academy_id))];
          const academies = academyIds.length
            ? await tx.academy.findMany({
                where: { id: { in: academyIds } },
                select: { id: true, name: true },
              })
            : [];
          const webhooks = await tx.communicationDelivery.count({
            where: {
              channel: 'email',
              status: { in: ['delivered', 'bounced', 'complained', 'deferred'] },
              createdAt: { gte: window.from, lt: window.to },
            },
          });
          return { grouped, academies, webhooks };
        },
      );

    const nameById = new Map(academies.map((a) => [a.id, a.name]));
    const byStatus = zeroedStatuses();
    const perAcademy = new Map<string, EmailActivityAcademySummary>();
    let total = 0;
    for (const row of grouped) {
      byStatus[row.ui_status] = (byStatus[row.ui_status] ?? 0) + row.n;
      total += row.n;
      const current =
        perAcademy.get(row.academy_id) ??
        ({
          academyId: row.academy_id,
          academyName: nameById.get(row.academy_id) ?? null,
          total: 0,
          byStatus: zeroedStatuses(),
        } as EmailActivityAcademySummary);
      (current.byStatus as Record<EmailActivityStatus, number>)[row.ui_status] += row.n;
      perAcademy.set(row.academy_id, { ...current, total: current.total + row.n });
    }
    const academiesSummary = [...perAcademy.values()]
      .sort((a, b) => b.total - a.total || a.academyId.localeCompare(b.academyId))
      .slice(0, TOP_ACADEMIES);
    return {
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      total,
      byStatus,
      academies: academiesSummary,
      deliveryWebhooksObserved: webhooks > 0,
    };
  }
}
