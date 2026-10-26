/**
 * G1 — the arithmetic of the CAC and capacity reports, pure (no I/O, no
 * clock): the services load rows and hand them here, the unit tests feed
 * rows directly.
 *
 * CAC (contract §3, analytics plan §2.5):
 *   - cohort = the Cairo calendar month the organization signed up in; a
 *     March signup that first pays in April counts as paying in March;
 *   - paying = of that cohort, organizations with a succeeded
 *     plan-subscription payment (so far); foundingPaying is the subset with
 *     a founding membership (still included in paying);
 *   - channel CAC = that month's spend on the channel ÷ that cohort's paying
 *     organizations on the channel, `null` when nobody pays yet;
 *   - blended CAC = all of the month's spend ÷ all of the cohort's paying
 *     organizations, `unknown` included; `unknown` never gets a channel row.
 *   - amounts are EGP minor units (piastres); a CAC is rounded to the
 *     nearest minor unit.
 */
import {
  SPEND_CHANNELS,
  type AcquisitionChannelValue,
  type SpendChannel,
} from '../common/attribution/acquisition-channel';
import type {
  CacChannelRow,
  CacMonth,
  CacReportResponse,
  CacTotals,
  CapacityAlert,
  CapacityAlertSeverity,
  CapacityReportResponse,
  CapacityWeek,
  HiringState,
} from './dto/growth.contract';
import { addDays, daysBetween } from './growth-time';

export interface CohortOrganization {
  /** Cairo signup month, `YYYY-MM`. */
  readonly month: string;
  readonly channel: AcquisitionChannelValue;
  readonly paying: boolean;
  readonly foundingPaying: boolean;
}

export interface SpendTotal {
  readonly month: string;
  readonly channel: SpendChannel;
  readonly amountMinorUnits: number;
}

/** `null` when nobody pays; otherwise rounded to the nearest minor unit. */
export function cacOf(spendMinorUnits: number, paying: number): number | null {
  return paying > 0 ? Math.round(spendMinorUnits / paying) : null;
}

/** A share in [0, 1] to 4 decimals, or `null` with nothing to divide by. */
export function ratioOf(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 10000) / 10000 : null;
}

interface Bucket {
  signups: number;
  paying: number;
  foundingPaying: number;
  spend: number;
}

const emptyBucket = (): Bucket => ({
  signups: 0,
  paying: 0,
  foundingPaying: 0,
  spend: 0,
});

function channelRows(buckets: Map<string, Bucket>): CacChannelRow[] {
  return SPEND_CHANNELS.map((channel) => {
    const b = buckets.get(channel) ?? emptyBucket();
    return {
      channel,
      signups: b.signups,
      paying: b.paying,
      foundingPaying: b.foundingPaying,
      spendMinorUnits: b.spend,
      cacMinorUnits: cacOf(b.spend, b.paying),
    };
  });
}

function totalsOf(buckets: Map<string, Bucket>): CacTotals {
  let signups = 0;
  let paying = 0;
  let foundingPaying = 0;
  let spend = 0;
  let unknownSignups = 0;
  for (const [channel, b] of buckets) {
    signups += b.signups;
    paying += b.paying;
    foundingPaying += b.foundingPaying;
    spend += b.spend;
    if (channel === 'unknown') unknownSignups += b.signups;
  }
  return {
    signups,
    paying,
    foundingPaying,
    spendMinorUnits: spend,
    blendedCacMinorUnits: cacOf(spend, paying),
    attributedSignups: signups - unknownSignups,
  };
}

function bucketFor(map: Map<string, Bucket>, channel: string): Bucket {
  let bucket = map.get(channel);
  if (!bucket) {
    bucket = emptyBucket();
    map.set(channel, bucket);
  }
  return bucket;
}

export function buildCacReport(input: {
  readonly months: readonly string[];
  readonly organizations: readonly CohortOrganization[];
  readonly spend: readonly SpendTotal[];
}): CacReportResponse {
  const perMonth = new Map<string, Map<string, Bucket>>(
    input.months.map((month) => [month, new Map()]),
  );
  const overall = new Map<string, Bucket>();
  for (const org of input.organizations) {
    const month = perMonth.get(org.month);
    if (!month) continue;
    for (const target of [
      bucketFor(month, org.channel),
      bucketFor(overall, org.channel),
    ]) {
      target.signups += 1;
      if (org.paying) target.paying += 1;
      if (org.paying && org.foundingPaying) target.foundingPaying += 1;
    }
  }
  for (const entry of input.spend) {
    const month = perMonth.get(entry.month);
    if (!month) continue;
    bucketFor(month, entry.channel).spend += entry.amountMinorUnits;
    bucketFor(overall, entry.channel).spend += entry.amountMinorUnits;
  }
  const months: CacMonth[] = input.months.map((month) => {
    const buckets = perMonth.get(month)!;
    return { month, channels: channelRows(buckets), totals: totalsOf(buckets) };
  });
  const overallTotals = totalsOf(overall);
  return {
    from: input.months[0],
    to: input.months[input.months.length - 1],
    currency: 'EGP',
    months,
    overall: { ...overallTotals, channels: channelRows(overall) },
    coverage: {
      signups: overallTotals.signups,
      attributedSignups: overallTotals.attributedSignups,
      ratio: ratioOf(overallTotals.attributedSignups, overallTotals.signups),
    },
  };
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

export interface CapacitySettings {
  readonly seasonStart: string;
  readonly seasonEnd: string;
  readonly weeklyOwnerHours: number;
  readonly onboardingCapPerWeek: number;
  readonly minutesPerOnboarding: number;
  readonly supportMinutesPerPayingOrgPerWeek: number;
  readonly hireWarnPayingOrgs: number;
  readonly hireNowPayingOrgs: number;
}

export interface CapacityInput {
  readonly now: Date;
  /** Today's Cairo date. */
  readonly today: string;
  /** The Saturday starting the current week. */
  readonly weekStart: string;
  readonly settings: CapacitySettings;
  /** The last 12 weeks, oldest first; the last one is the current week. */
  readonly weeks: readonly CapacityWeek[];
  readonly payingOrgs: number;
  readonly activeTrials: number;
  readonly openRequests: number;
  readonly oldestOpenRequestAt: Date | null;
  readonly last30Signups: number;
  readonly last30Attributed: number;
}

export const CAPACITY_THRESHOLDS = {
  utilizationWarning: 0.9,
  utilizationCritical: 1.0,
  requestsBacklogOpen: 10,
  requestsBacklogHours: 48,
  attributionMinSignups: 10,
  attributionMinRatio: 0.5,
  seasonSoonDays: 45,
} as const;

const SEVERITY_ORDER: Readonly<Record<CapacityAlertSeverity, number>> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export function seasonStatus(
  today: string,
  start: string,
  end: string,
): CapacityReportResponse['season'] {
  const inSeason = daysBetween(start, today) >= 0 && daysBetween(today, end) >= 0;
  const beforeSeason = daysBetween(today, start) > 0;
  return {
    start,
    end,
    inSeason,
    daysToStart: beforeSeason ? daysBetween(today, start) : null,
    daysLeft: inSeason ? daysBetween(today, end) : null,
  };
}

export function hiringState(
  payingOrgs: number,
  warnAt: number,
  hireAt: number,
): HiringState {
  if (payingOrgs >= hireAt) return 'hire';
  if (payingOrgs >= warnAt) return 'warn';
  return 'ok';
}

export function estimatedHours(
  onboardings: number,
  payingOrgs: number,
  settings: Pick<
    CapacitySettings,
    'minutesPerOnboarding' | 'supportMinutesPerPayingOrgPerWeek'
  >,
): number {
  const minutes =
    onboardings * settings.minutesPerOnboarding +
    payingOrgs * settings.supportMinutesPerPayingOrgPerWeek;
  return Math.round((minutes / 60) * 10) / 10;
}

export function buildCapacityReport(input: CapacityInput): CapacityReportResponse {
  const { settings } = input;
  const current: CapacityWeek = input.weeks[input.weeks.length - 1] ?? {
    start: input.weekStart,
    signups: 0,
    onboardings: 0,
    paidConversions: 0,
  };
  const season = seasonStatus(input.today, settings.seasonStart, settings.seasonEnd);
  const hours = estimatedHours(current.onboardings, input.payingOrgs, settings);
  const utilization = Math.round((hours / settings.weeklyOwnerHours) * 100) / 100;
  const state = hiringState(
    input.payingOrgs,
    settings.hireWarnPayingOrgs,
    settings.hireNowPayingOrgs,
  );
  const oldestOpenHours = input.oldestOpenRequestAt
    ? Math.max(
        0,
        Math.floor(
          (input.now.getTime() - input.oldestOpenRequestAt.getTime()) / 3_600_000,
        ),
      )
    : null;
  const attributionRatio = ratioOf(input.last30Attributed, input.last30Signups);

  const alerts: CapacityAlert[] = [];
  const cap = settings.onboardingCapPerWeek;
  if (current.onboardings >= cap) {
    alerts.push({
      key: 'onboarding_cap_reached',
      severity: current.onboardings > cap ? 'critical' : 'warning',
      params: { onboardings: current.onboardings, cap },
    });
  }
  if (utilization > CAPACITY_THRESHOLDS.utilizationWarning) {
    alerts.push({
      key: 'hours_over_capacity',
      severity:
        utilization > CAPACITY_THRESHOLDS.utilizationCritical ? 'critical' : 'warning',
      params: {
        estimatedHours: hours,
        ownerHours: settings.weeklyOwnerHours,
        utilization,
      },
    });
  }
  if (state === 'hire') {
    alerts.push({
      key: 'hire_now',
      severity: 'critical',
      params: { payingOrgs: input.payingOrgs, hireAt: settings.hireNowPayingOrgs },
    });
  } else if (state === 'warn') {
    alerts.push({
      key: 'hire_warn',
      severity: 'warning',
      params: {
        payingOrgs: input.payingOrgs,
        warnAt: settings.hireWarnPayingOrgs,
        hireAt: settings.hireNowPayingOrgs,
      },
    });
  }
  if (
    input.openRequests >= CAPACITY_THRESHOLDS.requestsBacklogOpen ||
    (oldestOpenHours !== null &&
      oldestOpenHours >= CAPACITY_THRESHOLDS.requestsBacklogHours)
  ) {
    alerts.push({
      key: 'requests_backlog',
      severity: 'warning',
      params: { open: input.openRequests, oldestOpenHours: oldestOpenHours ?? 0 },
    });
  }
  if (
    input.last30Signups >= CAPACITY_THRESHOLDS.attributionMinSignups &&
    attributionRatio !== null &&
    attributionRatio < CAPACITY_THRESHOLDS.attributionMinRatio
  ) {
    alerts.push({
      key: 'attribution_low',
      severity: 'info',
      params: {
        signups: input.last30Signups,
        attributed: input.last30Attributed,
        ratio: attributionRatio,
      },
    });
  }
  if (
    season.daysToStart !== null &&
    season.daysToStart <= CAPACITY_THRESHOLDS.seasonSoonDays
  ) {
    alerts.push({
      key: 'season_soon',
      severity: 'info',
      params: { daysToStart: season.daysToStart, start: season.start },
    });
  }
  if (season.inSeason) {
    alerts.push({
      key: 'in_season',
      severity: 'info',
      params: { daysLeft: season.daysLeft ?? 0, end: season.end },
    });
  }
  // Stable: critical, then warning, then info, each in the order above.
  const ordered = alerts
    .map((alert, index) => ({ alert, index }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.alert.severity] - SEVERITY_ORDER[b.alert.severity] ||
        a.index - b.index,
    )
    .map(({ alert }) => alert);

  return {
    now: input.now.toISOString(),
    timezone: 'Africa/Cairo',
    season,
    week: {
      start: input.weekStart,
      end: addDays(input.weekStart, 6),
      signups: current.signups,
      onboardings: current.onboardings,
      onboardingCap: cap,
      paidConversions: current.paidConversions,
    },
    load: {
      payingOrgs: input.payingOrgs,
      activeTrials: input.activeTrials,
      estimatedHoursThisWeek: hours,
      ownerHours: settings.weeklyOwnerHours,
      utilization,
    },
    requests: { open: input.openRequests, oldestOpenHours },
    hiring: {
      payingOrgs: input.payingOrgs,
      warnAt: settings.hireWarnPayingOrgs,
      hireAt: settings.hireNowPayingOrgs,
      state,
    },
    attribution: {
      last30Signups: input.last30Signups,
      last30Attributed: input.last30Attributed,
      ratio: attributionRatio,
    },
    weeks: input.weeks,
    alerts: ordered,
  };
}

/** Counts instants into the 12 week buckets (keyed by the Saturday that starts each). */
export function bucketByWeek(
  weekStarts: readonly string[],
  dates: readonly string[],
  weekOf: (date: string) => string,
): Map<string, number> {
  const counts = new Map<string, number>(weekStarts.map((start) => [start, 0]));
  for (const date of dates) {
    const start = weekOf(date);
    const count = counts.get(start);
    if (count !== undefined) counts.set(start, count + 1);
  }
  return counts;
}
