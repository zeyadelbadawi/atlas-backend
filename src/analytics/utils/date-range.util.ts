/**
 * P16 date-range resolution — no prior phase in this codebase filters by
 * an arbitrary caller-supplied date range (grep-verified: no existing
 * `dateFrom`/`dateTo`/`startOfDay`/`endOfDay` helper anywhere), so this is
 * this phase's own, deliberately small convention, matching the ONLY
 * shape the real frontend contract sends: `AnalyticsQuery.dateRange` is an
 * ISO 8601 *date* pair (`"2026-07-24"`), never a date-time — see
 * `analytics.types.ts`'s own doc comment and `AnalyticsService.toParams`
 * (`{from: dateRange.from, to: dateRange.to}`).
 *
 * Convention (documented here once, applied everywhere in this phase):
 * every date is interpreted in UTC; `from` is the INCLUSIVE start of that
 * UTC day (`00:00:00.000Z`), `to` is the INCLUSIVE end of that UTC day
 * (`23:59:59.999Z`) — matching `computeDateRange`'s own "last N days,
 * including today" semantics on the frontend (`analytics-date-range.
 * utils.ts`). When the query omits `dateRange` entirely (`AnalyticsQuery`
 * is `{}`-shaped on `getOverview()`/every hook call with no explicit
 * range), this defaults to the same last-30-days window
 * `AnalyticsPage`'s own initial `preset` state (`'30d'`) opens with — so
 * an unfiltered request and the frontend's own default render agree.
 */
import { BadRequestException } from '@nestjs/common';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RANGE_DAYS = 30;

export interface ResolvedDateRange {
  /** Inclusive, UTC start-of-day. */
  readonly from: Date;
  /** Inclusive, UTC end-of-day. */
  readonly to: Date;
}

function parseDateOnly(value: string, field: 'from' | 'to'): Date {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new BadRequestException({
      messageKey: 'errors.analytics.invalidDateRange',
      field,
    });
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException({
      messageKey: 'errors.analytics.invalidDateRange',
      field,
    });
  }
  return date;
}

/** Resolves the optional `from`/`to` query params into a concrete, validated, inclusive UTC range — defaulting to the last 30 days (matching the frontend's own initial preset) when both are omitted. */
export function resolveDateRange(from?: string, to?: string): ResolvedDateRange {
  if (!from && !to) {
    const now = new Date();
    const toDate = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        23,
        59,
        59,
        999,
      ),
    );
    const fromDate = new Date(toDate);
    fromDate.setUTCDate(fromDate.getUTCDate() - (DEFAULT_RANGE_DAYS - 1));
    fromDate.setUTCHours(0, 0, 0, 0);
    return { from: fromDate, to: toDate };
  }

  if (!from || !to) {
    throw new BadRequestException({ messageKey: 'errors.analytics.invalidDateRange' });
  }

  const fromDate = parseDateOnly(from, 'from');
  const toStartOfDay = parseDateOnly(to, 'to');
  const toDate = new Date(toStartOfDay.getTime() + (24 * 60 * 60 * 1000 - 1));

  if (fromDate.getTime() > toDate.getTime()) {
    throw new BadRequestException({ messageKey: 'errors.analytics.invalidDateRange' });
  }

  return { from: fromDate, to: toDate };
}

/** The immediately preceding period of equal length, used for every "vs previous period" `changePercent` in this phase (never a calendar-arbitrary comparison). */
export function previousPeriod(range: ResolvedDateRange): ResolvedDateRange {
  const lengthMs = range.to.getTime() - range.from.getTime() + 1;
  const to = new Date(range.from.getTime() - 1);
  const from = new Date(range.from.getTime() - lengthMs);
  return { from, to };
}

/** ISO date-only string (`YYYY-MM-DD`), UTC. */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Every UTC calendar day in `[from, to]`, inclusive, as `YYYY-MM-DD` strings — the fixed bucket set every time-series query fills gaps against. */
export function enumerateDays(range: ResolvedDateRange): string[] {
  const days: string[] = [];
  const cursor = new Date(
    Date.UTC(
      range.from.getUTCFullYear(),
      range.from.getUTCMonth(),
      range.from.getUTCDate(),
    ),
  );
  const last = new Date(
    Date.UTC(range.to.getUTCFullYear(), range.to.getUTCMonth(), range.to.getUTCDate()),
  );
  while (cursor.getTime() <= last.getTime()) {
    days.push(toIsoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** The current UTC calendar month, `[start, end]`, inclusive — `PlatformMetricsOverview`'s own "vs last month" trend convention (distinct from the rolling `dateRange` convention above; that KPI takes no date-range param at all, see `PlatformMetricsService.getOverview()`'s zero-argument signature). */
export function currentCalendarMonth(now = new Date()): ResolvedDateRange {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const to = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999),
  );
  return { from, to };
}

/** The calendar month immediately before `range`'s month. */
export function previousCalendarMonth(range: ResolvedDateRange): ResolvedDateRange {
  const from = new Date(
    Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth() - 1, 1, 0, 0, 0, 0),
  );
  const to = new Date(
    Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), 0, 23, 59, 59, 999),
  );
  return { from, to };
}
