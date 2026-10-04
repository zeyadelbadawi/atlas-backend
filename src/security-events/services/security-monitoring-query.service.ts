/**
 * SecurityMonitoringQueryService — W3: the reads behind the Platform
 * Owner's OTP & Security Monitoring page.
 *
 * Every read runs under the CALLING platform owner's own user context, so
 * `security_events_platform_select` (the only SELECT policy the table has)
 * proves the guard's decision a second time, independently. Pre-auth events
 * are therefore unreadable by anyone else at the database level, not merely
 * hidden by this service.
 *
 * Filters by email or IP never store or echo the input: the server hashes
 * it exactly as the writer did and compares hashes. Responses carry a
 * masked address only for a known account and an 8-character prefix of each
 * hash for correlation — never a full hash, address, IP or code.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, type SecurityEventType } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { maskEmail } from '../../identity/services/email-otp.service';
import { normalizeEmail } from '../../identity/utils/email.util';
import { SecurityEventHasher } from './security-event-hasher.service';
import type { SecurityMonitoringQueryDto } from '../dto/security-monitoring.dto';
import type {
  SecurityEventItem,
  SecurityEventPage,
  SecurityMonitoringDay,
  SecurityMonitoringSummary,
  SecurityMonitoringTotals,
} from '../dto/security-monitoring.contract';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 25;
const REF_LENGTH = 8;

const TOTAL_FIELD: Record<SecurityEventType, keyof SecurityMonitoringTotals> = {
  otp_sent: 'otpSent',
  otp_resent: 'otpResent',
  otp_verified: 'otpVerified',
  otp_failed: 'otpFailed',
  otp_expired: 'otpExpired',
  otp_locked: 'otpLocked',
  otp_suppressed: 'otpSuppressed',
  otp_rate_limited: 'otpRateLimited',
  signin_rate_limited: 'signinRateLimited',
  deletion_code_sent: 'deletionCodeSent',
  deletion_code_verified: 'deletionCodeVerified',
  deletion_code_failed: 'deletionCodeFailed',
  deletion_code_locked: 'deletionCodeLocked',
  deletion_code_rate_limited: 'deletionCodeRateLimited',
};

/** Which daily series column an event type feeds (deletion codes included). */
const SERIES_FIELD: Partial<
  Record<SecurityEventType, keyof Omit<SecurityMonitoringDay, 'date'>>
> = {
  otp_sent: 'sent',
  otp_resent: 'sent',
  deletion_code_sent: 'sent',
  otp_verified: 'verified',
  deletion_code_verified: 'verified',
  otp_failed: 'failed',
  otp_expired: 'failed',
  deletion_code_failed: 'failed',
  otp_locked: 'locked',
  deletion_code_locked: 'locked',
  otp_rate_limited: 'rateLimited',
  signin_rate_limited: 'rateLimited',
  deletion_code_rate_limited: 'rateLimited',
};

interface EventRow {
  readonly id: string;
  readonly event_type: SecurityEventType;
  readonly surface: string | null;
  readonly user_id: string | null;
  readonly subject_hash: string | null;
  readonly ip_hash: string | null;
  readonly academy_id: string | null;
  readonly reason: string | null;
  readonly attempts_remaining: number | null;
  readonly occurrences: number;
  readonly created_at: Date;
}

function zeroTotals(): SecurityMonitoringTotals {
  return Object.fromEntries(
    Object.values(TOTAL_FIELD).map((field) => [field, 0]),
  ) as unknown as SecurityMonitoringTotals;
}

export function encodeEventCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeEventCursor(
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

@Injectable()
export class SecurityMonitoringQueryService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly hasher: SecurityEventHasher,
  ) {}

  async summary(
    platformOwnerUserId: string,
    query: SecurityMonitoringQueryDto,
    now: Date = new Date(),
  ): Promise<SecurityMonitoringSummary> {
    const windowDays = query.days ?? DEFAULT_DAYS;
    const since = new Date(now.getTime() - windowDays * DAY_MS);
    const conditions = await this.conditions(platformOwnerUserId, query, since, now);

    const rows = await this.tenancyContextService.runInUserContext(
      platformOwnerUserId,
      (tx) => tx.$queryRaw<{ day: string; event_type: SecurityEventType; n: number }[]>`
        SELECT to_char(date_trunc('day', e."created_at"), 'YYYY-MM-DD') AS "day",
               e."event_type"::text AS "event_type",
               COALESCE(SUM(e."occurrences"), 0)::int AS "n"
          FROM "security_events" e
         WHERE ${Prisma.join(conditions, ' AND ')}
         GROUP BY 1, 2
      `,
    );

    const totals = zeroTotals() as Record<keyof SecurityMonitoringTotals, number>;
    const days = new Map<
      string,
      Record<keyof Omit<SecurityMonitoringDay, 'date'>, number>
    >();
    // Every UTC day in the window is present, so a chart never mistakes a
    // quiet day for a gap in the data.
    const firstDay = Date.UTC(
      since.getUTCFullYear(),
      since.getUTCMonth(),
      since.getUTCDate(),
    );
    for (let t = firstDay; t <= now.getTime(); t += DAY_MS) {
      days.set(new Date(t).toISOString().slice(0, 10), {
        sent: 0,
        verified: 0,
        failed: 0,
        locked: 0,
        rateLimited: 0,
      });
    }
    for (const row of rows) {
      const field = TOTAL_FIELD[row.event_type];
      if (field) totals[field] += row.n;
      const seriesField = SERIES_FIELD[row.event_type];
      const day = days.get(row.day);
      if (seriesField && day) day[seriesField] += row.n;
    }
    const sent = totals.otpSent + totals.otpResent;
    return {
      windowDays,
      totals,
      verifyRate: sent === 0 ? null : Math.min(1, totals.otpVerified / sent),
      series: [...days.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, counts]) => ({ date, ...counts })),
      generatedAt: now.toISOString(),
    };
  }

  async events(
    platformOwnerUserId: string,
    query: SecurityMonitoringQueryDto,
    now: Date = new Date(),
  ): Promise<SecurityEventPage> {
    const windowDays = query.days ?? DEFAULT_DAYS;
    const since = new Date(now.getTime() - windowDays * DAY_MS);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const cursor = query.cursor ? decodeEventCursor(query.cursor) : null;
    if (query.cursor && !cursor) {
      throw new BadRequestException({ messageKey: 'errors.validation.failed' });
    }
    const conditions = await this.conditions(platformOwnerUserId, query, since, now);
    if (query.type) {
      conditions.push(
        Prisma.sql`e."event_type" = CAST(${query.type} AS "security_event_type")`,
      );
    }
    if (cursor) {
      conditions.push(
        Prisma.sql`(e."created_at", e."id") < (${cursor.createdAt}, ${cursor.id})`,
      );
    }

    const { rows, users, academies } = await this.tenancyContextService.runInUserContext(
      platformOwnerUserId,
      async (tx) => {
        const rows = await tx.$queryRaw<EventRow[]>`
          SELECT e."id", e."event_type"::text AS "event_type", e."surface", e."user_id",
                 e."subject_hash", e."ip_hash", e."academy_id", e."reason",
                 e."attempts_remaining", e."occurrences", e."created_at"
            FROM "security_events" e
           WHERE ${Prisma.join(conditions, ' AND ')}
           ORDER BY e."created_at" DESC, e."id" DESC
           LIMIT ${limit + 1}
        `;
        const page = rows.slice(0, limit);
        const userIds = [
          ...new Set(page.map((r) => r.user_id).filter((v): v is string => !!v)),
        ];
        const academyIds = [
          ...new Set(page.map((r) => r.academy_id).filter((v): v is string => !!v)),
        ];
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
    const items: SecurityEventItem[] = page.map((row) => {
      const email = row.user_id ? emailById.get(row.user_id) : undefined;
      return {
        id: row.id,
        type: row.event_type,
        surface:
          row.surface === 'management' || row.surface === 'academy' ? row.surface : null,
        academy: row.academy_id
          ? { id: row.academy_id, name: nameById.get(row.academy_id) ?? null }
          : null,
        maskedEmail: email ? maskEmail(email) : null,
        subjectRef: row.subject_hash ? row.subject_hash.slice(0, REF_LENGTH) : null,
        ipRef: row.ip_hash ? row.ip_hash.slice(0, REF_LENGTH) : null,
        reason: row.reason,
        attemptsRemaining: row.attempts_remaining,
        occurrences: row.occurrences,
        createdAt: row.created_at.toISOString(),
      };
    });
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        rows.length > limit && last ? encodeEventCursor(last.created_at, last.id) : null,
    };
  }

  /** WHERE fragments shared by both reads (window, surface, academy, email, IP). */
  private async conditions(
    platformOwnerUserId: string,
    query: SecurityMonitoringQueryDto,
    since: Date,
    now: Date,
  ): Promise<Prisma.Sql[]> {
    const conditions: Prisma.Sql[] = [Prisma.sql`e."created_at" >= ${since}`];
    if (query.surface) conditions.push(Prisma.sql`e."surface" = ${query.surface}`);
    if (query.academyId) conditions.push(Prisma.sql`e."academy_id" = ${query.academyId}`);
    if (query.email) {
      const subjectHash = this.hasher.subjectHash(query.email);
      const normalized = normalizeEmail(query.email);
      const user = await this.tenancyContextService.runInUserContext(
        platformOwnerUserId,
        (tx) =>
          tx.user.findFirst({
            where: { email: { equals: normalized, mode: 'insensitive' } },
            select: { id: true },
          }),
      );
      conditions.push(
        user
          ? Prisma.sql`(e."subject_hash" = ${subjectHash} OR e."user_id" = ${user.id})`
          : Prisma.sql`e."subject_hash" = ${subjectHash}`,
      );
    }
    if (query.ip) {
      const hashes = this.hasher.ipHashesForWindow(query.ip, since, now);
      conditions.push(Prisma.sql`e."ip_hash" = ANY(${hashes}::text[])`);
    }
    return conditions;
  }
}
