/**
 * `marketing_event_daily` — platform-level aggregate counts, no RLS (see the
 * model's schema comment), so plain `PrismaService` outside any tenant or
 * user context, like `TenantUsageSweepCursorRepository`.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { MarketingEventIncrement } from './marketing-events.util';

export interface MarketingEventAggregateRow {
  readonly name: string;
  readonly page: string;
  readonly locale: string;
  readonly device: string;
  readonly value: string;
  readonly utmSource: string;
  readonly utmMedium: string;
  readonly utmCampaign: string;
  readonly referrerDomain: string;
  readonly count: number;
}

@Injectable()
export class MarketingEventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Adds each increment to its day's row in ONE statement. `ON CONFLICT`
   * on the primary key makes concurrent beacons (any number of instances)
   * safe; the caller passes rows with distinct dimensions
   * (`aggregateMarketingEvents`), which `ON CONFLICT` requires.
   */
  async increment(day: Date, rows: readonly MarketingEventIncrement[]): Promise<void> {
    if (rows.length === 0) return;
    const values = rows.map(
      (row) =>
        Prisma.sql`(${day}::date, ${row.name}, ${row.page}, ${row.locale}, ${row.device}, ${row.value}, ${row.utmSource}, ${row.utmMedium}, ${row.utmCampaign}, ${row.referrerDomain}, ${row.count}::int, CURRENT_TIMESTAMP)`,
    );
    await this.prisma.$executeRaw`
      INSERT INTO "marketing_event_daily"
        ("day", "name", "page", "locale", "device", "value",
         "utm_source", "utm_medium", "utm_campaign", "referrer_domain",
         "count", "updated_at")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("day", "name", "page", "locale", "device", "value",
                   "utm_source", "utm_medium", "utm_campaign", "referrer_domain")
      DO UPDATE SET
        "count" = "marketing_event_daily"."count" + EXCLUDED."count",
        "updated_at" = CURRENT_TIMESTAMP`;
  }

  /** Counts summed over `[from, to]` (inclusive UTC days), per dimension combination. */
  async sumBetween(from: Date, to: Date): Promise<MarketingEventAggregateRow[]> {
    const groups = await this.prisma.marketingEventDaily.groupBy({
      by: [
        'name',
        'page',
        'locale',
        'device',
        'value',
        'utmSource',
        'utmMedium',
        'utmCampaign',
        'referrerDomain',
      ],
      where: { day: { gte: from, lte: to } },
      _sum: { count: true },
      orderBy: [{ name: 'asc' }, { page: 'asc' }, { value: 'asc' }],
    });
    return groups.map(({ _sum, ...dimensions }) => ({
      ...dimensions,
      count: _sum.count ?? 0,
    }));
  }

  /** Deletes every row for a day before `cutoff`; returns how many went. */
  async deleteBefore(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.marketingEventDaily.deleteMany({
      where: { day: { lt: cutoff } },
    });
    return count;
  }
}
