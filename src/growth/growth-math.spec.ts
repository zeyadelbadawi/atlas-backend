/**
 * G1 — CAC arithmetic (cohort by signup month, founding subset, null CAC
 * with no paying organization, blended CAC including `unknown`) and the
 * capacity report (season, load, hiring, alert thresholds).
 */
import {
  CAPACITY_THRESHOLDS,
  buildCacReport,
  buildCapacityReport,
  bucketByWeek,
  cacOf,
  estimatedHours,
  hiringState,
  ratioOf,
  seasonStatus,
  type CapacityInput,
  type CohortOrganization,
} from './growth-math';
import { weekStartSaturday } from './growth-time';

const org = (
  month: string,
  channel: CohortOrganization['channel'],
  paying = false,
  foundingPaying = false,
): CohortOrganization => ({ month, channel, paying, foundingPaying });

describe('cacOf / ratioOf', () => {
  it('null when nobody pays; rounded to the nearest minor unit otherwise', () => {
    expect(cacOf(500_000, 0)).toBeNull();
    expect(cacOf(0, 0)).toBeNull();
    expect(cacOf(100_000, 3)).toBe(33_333);
    expect(cacOf(200_000, 3)).toBe(66_667);
    expect(cacOf(0, 2)).toBe(0);
  });

  it('ratio to 4 decimals, null with nothing to divide by', () => {
    expect(ratioOf(1, 3)).toBe(0.3333);
    expect(ratioOf(0, 0)).toBeNull();
  });
});

describe('buildCacReport', () => {
  const months = ['2026-03', '2026-04'];

  it('cohort by signup month: a March signup that pays later counts as paying in March', () => {
    const report = buildCacReport({
      months,
      organizations: [org('2026-03', 'facebook', true)],
      spend: [{ month: '2026-04', channel: 'facebook', amountMinorUnits: 50_000 }],
    });
    const march = report.months[0];
    const april = report.months[1];
    expect(march.totals).toMatchObject({ signups: 1, paying: 1, spendMinorUnits: 0 });
    expect(march.channels.find((c) => c.channel === 'facebook')).toMatchObject({
      paying: 1,
      spendMinorUnits: 0,
      cacMinorUnits: 0,
    });
    // April spent on facebook but its cohort has nobody paying yet → null CAC.
    expect(april.channels.find((c) => c.channel === 'facebook')).toMatchObject({
      signups: 0,
      paying: 0,
      spendMinorUnits: 50_000,
      cacMinorUnits: null,
    });
    expect(april.totals.blendedCacMinorUnits).toBeNull();
  });

  it('channel CAC = spend ÷ paying; foundingPaying is a subset of paying', () => {
    const report = buildCacReport({
      months: ['2026-05'],
      organizations: [
        org('2026-05', 'meta_ads', true, true),
        org('2026-05', 'meta_ads', true, false),
        org('2026-05', 'meta_ads', false, false),
        // founding without paying never counts as foundingPaying
        org('2026-05', 'meta_ads', false, true),
      ],
      spend: [{ month: '2026-05', channel: 'meta_ads', amountMinorUnits: 300_000 }],
    });
    const row = report.months[0].channels.find((c) => c.channel === 'meta_ads')!;
    expect(row).toEqual({
      channel: 'meta_ads',
      signups: 4,
      paying: 2,
      foundingPaying: 1,
      spendMinorUnits: 300_000,
      cacMinorUnits: 150_000,
    });
  });

  it('blended CAC includes unknown; channel rows never list unknown', () => {
    const report = buildCacReport({
      months: ['2026-05'],
      organizations: [
        org('2026-05', 'unknown', true),
        org('2026-05', 'unknown', false),
        org('2026-05', 'google_ads', true),
        org('2026-05', 'whatsapp', false),
      ],
      spend: [
        { month: '2026-05', channel: 'google_ads', amountMinorUnits: 400_000 },
        { month: '2026-05', channel: 'other', amountMinorUnits: 100_000 },
      ],
    });
    const month = report.months[0];
    expect(month.channels.map((c) => c.channel)).not.toContain('unknown');
    expect(month.channels).toHaveLength(15);
    expect(month.totals).toEqual({
      signups: 4,
      paying: 2,
      foundingPaying: 0,
      spendMinorUnits: 500_000,
      blendedCacMinorUnits: 250_000,
      attributedSignups: 2,
    });
    expect(month.channels.find((c) => c.channel === 'google_ads')!.cacMinorUnits).toBe(
      400_000,
    );
    expect(month.channels.find((c) => c.channel === 'other')).toMatchObject({
      signups: 0,
      spendMinorUnits: 100_000,
      cacMinorUnits: null,
    });
  });

  it('overall aggregates the range; coverage = attributed ÷ signups', () => {
    const report = buildCacReport({
      months,
      organizations: [
        org('2026-03', 'facebook', true),
        org('2026-04', 'facebook', true),
        org('2026-04', 'unknown', false),
        org('2026-04', 'unknown', false),
        // outside the window → ignored
        org('2026-02', 'facebook', true),
      ],
      spend: [
        { month: '2026-03', channel: 'facebook', amountMinorUnits: 100_000 },
        { month: '2026-04', channel: 'facebook', amountMinorUnits: 300_000 },
        { month: '2026-05', channel: 'facebook', amountMinorUnits: 999_999 },
      ],
    });
    expect(report.from).toBe('2026-03');
    expect(report.to).toBe('2026-04');
    expect(report.currency).toBe('EGP');
    expect(report.overall).toMatchObject({
      signups: 4,
      paying: 2,
      spendMinorUnits: 400_000,
      blendedCacMinorUnits: 200_000,
      attributedSignups: 2,
    });
    expect(report.overall.channels.find((c) => c.channel === 'facebook')).toMatchObject({
      signups: 2,
      paying: 2,
      spendMinorUnits: 400_000,
      cacMinorUnits: 200_000,
    });
    expect(report.coverage).toEqual({ signups: 4, attributedSignups: 2, ratio: 0.5 });
  });

  it('an empty range has zero rows everywhere, null CACs and a null coverage ratio', () => {
    const report = buildCacReport({ months, organizations: [], spend: [] });
    expect(report.months).toHaveLength(2);
    expect(report.months[0].totals).toEqual({
      signups: 0,
      paying: 0,
      foundingPaying: 0,
      spendMinorUnits: 0,
      blendedCacMinorUnits: null,
      attributedSignups: 0,
    });
    expect(report.coverage.ratio).toBeNull();
  });
});

describe('capacity helpers', () => {
  it('season: before, in (first and last day), after', () => {
    expect(seasonStatus('2027-04-17', '2027-06-01', '2027-09-30')).toEqual({
      start: '2027-06-01',
      end: '2027-09-30',
      inSeason: false,
      daysToStart: 45,
      daysLeft: null,
    });
    expect(seasonStatus('2027-06-01', '2027-06-01', '2027-09-30')).toMatchObject({
      inSeason: true,
      daysToStart: null,
      daysLeft: 121,
    });
    expect(seasonStatus('2027-09-30', '2027-06-01', '2027-09-30')).toMatchObject({
      inSeason: true,
      daysLeft: 0,
    });
    expect(seasonStatus('2027-10-01', '2027-06-01', '2027-09-30')).toMatchObject({
      inSeason: false,
      daysToStart: null,
      daysLeft: null,
    });
  });

  it('hiring state at the thresholds', () => {
    expect(hiringState(32, 33, 40)).toBe('ok');
    expect(hiringState(33, 33, 40)).toBe('warn');
    expect(hiringState(39, 33, 40)).toBe('warn');
    expect(hiringState(40, 33, 40)).toBe('hire');
  });

  it('estimated hours = onboardings × minutes + paying × support minutes', () => {
    expect(
      estimatedHours(5, 30, {
        minutesPerOnboarding: 120,
        supportMinutesPerPayingOrgPerWeek: 10,
      }),
    ).toBe(15);
    expect(
      estimatedHours(1, 1, {
        minutesPerOnboarding: 120,
        supportMinutesPerPayingOrgPerWeek: 10,
      }),
    ).toBe(2.2);
  });

  it('buckets dates into Saturday weeks and ignores dates outside them', () => {
    const counts = bucketByWeek(
      ['2026-10-17', '2026-10-24'],
      [
        '2026-10-17',
        '2026-10-23',
        '2026-10-24',
        '2026-10-30',
        '2026-10-31',
        '2026-10-01',
      ],
      weekStartSaturday,
    );
    expect([...counts.entries()]).toEqual([
      ['2026-10-17', 2],
      ['2026-10-24', 2],
    ]);
  });
});

describe('buildCapacityReport', () => {
  const NOW = new Date('2026-10-26T10:00:00Z');
  const base: CapacityInput = {
    now: NOW,
    today: '2026-10-26',
    weekStart: '2026-10-24',
    settings: {
      seasonStart: '2027-06-01',
      seasonEnd: '2027-09-30',
      weeklyOwnerHours: 15,
      onboardingCapPerWeek: 5,
      minutesPerOnboarding: 120,
      supportMinutesPerPayingOrgPerWeek: 10,
      hireWarnPayingOrgs: 33,
      hireNowPayingOrgs: 40,
    },
    weeks: [{ start: '2026-10-24', signups: 2, onboardings: 1, paidConversions: 1 }],
    payingOrgs: 6,
    activeTrials: 3,
    openRequests: 0,
    oldestOpenRequestAt: null,
    last30Signups: 4,
    last30Attributed: 1,
  };
  const keys = (input: Partial<CapacityInput>) =>
    buildCapacityReport({ ...base, ...input }).alerts.map(
      (a) => `${a.key}:${a.severity}`,
    );
  const week = (onboardings: number) => [
    { start: '2026-10-24', signups: 0, onboardings, paidConversions: 0 },
  ];

  it('shapes the week, load, hiring and season (off season, no alerts)', () => {
    const report = buildCapacityReport(base);
    expect(report.timezone).toBe('Africa/Cairo');
    expect(report.now).toBe(NOW.toISOString());
    expect(report.week).toEqual({
      start: '2026-10-24',
      end: '2026-10-30',
      signups: 2,
      onboardings: 1,
      onboardingCap: 5,
      paidConversions: 1,
    });
    expect(report.load).toEqual({
      payingOrgs: 6,
      activeTrials: 3,
      estimatedHoursThisWeek: 3,
      ownerHours: 15,
      utilization: 0.2,
    });
    expect(report.hiring).toEqual({ payingOrgs: 6, warnAt: 33, hireAt: 40, state: 'ok' });
    expect(report.season).toMatchObject({
      inSeason: false,
      daysToStart: 218,
      daysLeft: null,
    });
    expect(report.requests).toEqual({ open: 0, oldestOpenHours: null });
    expect(report.attribution).toEqual({
      last30Signups: 4,
      last30Attributed: 1,
      ratio: 0.25,
    });
    expect(report.alerts).toEqual([]);
  });

  it('onboarding cap: = cap → warning, > cap → critical, below → none', () => {
    expect(keys({ weeks: week(4) })).not.toContain('onboarding_cap_reached:warning');
    expect(keys({ weeks: week(5) })).toContain('onboarding_cap_reached:warning');
    expect(keys({ weeks: week(6) })).toContain('onboarding_cap_reached:critical');
  });

  it('hours: utilization > 0.9 → warning, > 1.0 → critical, exactly 0.9 / 1.0 → lower band', () => {
    // 0 onboardings; support 10 min × paying. 15 h = 900 min.
    expect(keys({ payingOrgs: 81, weeks: week(0) })).not.toContain(
      'hours_over_capacity:warning',
    ); // 13.5 h = 0.9
    expect(keys({ payingOrgs: 82, weeks: week(0) })).toContain(
      'hours_over_capacity:warning',
    ); // 13.7 h
    expect(keys({ payingOrgs: 90, weeks: week(0) })).toContain(
      'hours_over_capacity:warning',
    ); // 15 h = 1.0
    expect(keys({ payingOrgs: 91, weeks: week(0) })).toContain(
      'hours_over_capacity:critical',
    );
  });

  it('hiring: warn at 33 (warning), hire at 40 (critical, replaces warn)', () => {
    expect(keys({ payingOrgs: 32 })).toEqual([]);
    expect(keys({ payingOrgs: 33 })).toEqual(['hire_warn:warning']);
    const atHire = keys({ payingOrgs: 40 });
    expect(atHire).toContain('hire_now:critical');
    expect(atHire).not.toContain('hire_warn:warning');
  });

  it('requests backlog: ≥ 10 open, or the oldest ≥ 48 h', () => {
    expect(keys({ openRequests: 9 })).toEqual([]);
    expect(keys({ openRequests: 10 })).toEqual(['requests_backlog:warning']);
    expect(
      keys({
        openRequests: 1,
        oldestOpenRequestAt: new Date(NOW.getTime() - 47.9 * 3600_000),
      }),
    ).toEqual([]);
    const old = buildCapacityReport({
      ...base,
      openRequests: 1,
      oldestOpenRequestAt: new Date(NOW.getTime() - 48 * 3600_000),
    });
    expect(old.alerts).toEqual([
      {
        key: 'requests_backlog',
        severity: 'warning',
        params: { open: 1, oldestOpenHours: 48 },
      },
    ]);
    expect(old.requests).toEqual({ open: 1, oldestOpenHours: 48 });
  });

  it('attribution low: ≥ 10 signups in 30 days and ratio < 0.5 (info)', () => {
    expect(keys({ last30Signups: 9, last30Attributed: 0 })).toEqual([]);
    expect(keys({ last30Signups: 10, last30Attributed: 4 })).toEqual([
      'attribution_low:info',
    ]);
    expect(keys({ last30Signups: 10, last30Attributed: 5 })).toEqual([]);
    expect(CAPACITY_THRESHOLDS.attributionMinRatio).toBe(0.5);
  });

  it('season soon at ≤ 45 days (info); in season (info)', () => {
    expect(keys({ today: '2027-04-16' })).toEqual([]); // 46 days
    const soon = buildCapacityReport({ ...base, today: '2027-04-17' });
    expect(soon.alerts).toEqual([
      {
        key: 'season_soon',
        severity: 'info',
        params: { daysToStart: 45, start: '2027-06-01' },
      },
    ]);
    const inSeason = buildCapacityReport({ ...base, today: '2027-09-01' });
    expect(inSeason.alerts).toEqual([
      { key: 'in_season', severity: 'info', params: { daysLeft: 29, end: '2027-09-30' } },
    ]);
  });

  it('orders alerts critical → warning → info', () => {
    expect(
      keys({
        weeks: week(6),
        payingOrgs: 35,
        openRequests: 12,
        last30Signups: 20,
        last30Attributed: 2,
        today: '2027-07-01',
      }),
    ).toEqual([
      'onboarding_cap_reached:critical',
      'hours_over_capacity:critical',
      'hire_warn:warning',
      'requests_backlog:warning',
      'attribution_low:info',
      'in_season:info',
    ]);
  });
});
