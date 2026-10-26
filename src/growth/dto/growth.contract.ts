/**
 * G1 — response shapes of `platform-growth/*` and the additive
 * `acquisition` block of the Platform Owner organization detail. Matched
 * by the frontend's types.
 */
import type {
  AcquisitionChannelValue,
  ChannelDecidedBy,
  SelfReportedChannel,
  SpendChannel,
} from '../../common/attribution/acquisition-channel';

export interface GrowthSettingsResponse {
  readonly seasonStart: string;
  readonly seasonEnd: string;
  readonly weeklyOwnerHours: number;
  readonly onboardingCapPerWeek: number;
  readonly minutesPerOnboarding: number;
  readonly supportMinutesPerPayingOrgPerWeek: number;
  readonly hireWarnPayingOrgs: number;
  readonly hireNowPayingOrgs: number;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedByName: string | null;
}

export interface SpendEntryResponse {
  readonly id: string;
  readonly month: string;
  readonly channel: SpendChannel;
  readonly amountMinorUnits: number;
  readonly currency: 'EGP';
  readonly description: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdByName: string | null;
  readonly updatedByName: string | null;
}

export interface SpendListResponse {
  readonly from: string;
  readonly to: string;
  readonly items: readonly SpendEntryResponse[];
}

export interface CacChannelRow {
  readonly channel: SpendChannel;
  readonly signups: number;
  readonly paying: number;
  readonly foundingPaying: number;
  readonly spendMinorUnits: number;
  readonly cacMinorUnits: number | null;
}

export interface CacTotals {
  readonly signups: number;
  readonly paying: number;
  readonly foundingPaying: number;
  readonly spendMinorUnits: number;
  readonly blendedCacMinorUnits: number | null;
  readonly attributedSignups: number;
}

export interface CacMonth {
  readonly month: string;
  readonly channels: readonly CacChannelRow[];
  readonly totals: CacTotals;
}

export interface CacReportResponse {
  readonly from: string;
  readonly to: string;
  readonly currency: 'EGP';
  readonly months: readonly CacMonth[];
  readonly overall: CacTotals & { readonly channels: readonly CacChannelRow[] };
  readonly coverage: {
    readonly signups: number;
    readonly attributedSignups: number;
    readonly ratio: number | null;
  };
}

export const CAPACITY_ALERT_KEYS = [
  'onboarding_cap_reached',
  'hours_over_capacity',
  'hire_warn',
  'hire_now',
  'requests_backlog',
  'attribution_low',
  'season_soon',
  'in_season',
] as const;
export type CapacityAlertKey = (typeof CAPACITY_ALERT_KEYS)[number];
export type CapacityAlertSeverity = 'info' | 'warning' | 'critical';

export interface CapacityAlert {
  readonly key: CapacityAlertKey;
  readonly severity: CapacityAlertSeverity;
  readonly params: Readonly<Record<string, number | string>>;
}

export interface CapacityWeek {
  readonly start: string;
  readonly signups: number;
  readonly onboardings: number;
  readonly paidConversions: number;
}

export type HiringState = 'ok' | 'warn' | 'hire';

export interface CapacityReportResponse {
  readonly now: string;
  readonly timezone: 'Africa/Cairo';
  readonly season: {
    readonly start: string;
    readonly end: string;
    readonly inSeason: boolean;
    readonly daysToStart: number | null;
    readonly daysLeft: number | null;
  };
  readonly week: {
    readonly start: string;
    readonly end: string;
    readonly signups: number;
    readonly onboardings: number;
    readonly onboardingCap: number;
    readonly paidConversions: number;
  };
  readonly load: {
    readonly payingOrgs: number;
    readonly activeTrials: number;
    readonly estimatedHoursThisWeek: number;
    readonly ownerHours: number;
    readonly utilization: number;
  };
  readonly requests: { readonly open: number; readonly oldestOpenHours: number | null };
  readonly hiring: {
    readonly payingOrgs: number;
    readonly warnAt: number;
    readonly hireAt: number;
    readonly state: HiringState;
  };
  readonly attribution: {
    readonly last30Signups: number;
    readonly last30Attributed: number;
    readonly ratio: number | null;
  };
  readonly weeks: readonly CapacityWeek[];
  readonly alerts: readonly CapacityAlert[];
}

export interface OrganizationAcquisitionResponse {
  readonly resolvedChannel: AcquisitionChannelValue;
  readonly decidedBy: ChannelDecidedBy;
  readonly override: {
    readonly channel: AcquisitionChannelValue;
    readonly note: string | null;
    readonly updatedAt: string | null;
    readonly updatedByName: string | null;
  } | null;
  readonly heardFrom: SelfReportedChannel | null;
  readonly heardFromOther: string | null;
  readonly attribution: Record<string, string> | null;
}
