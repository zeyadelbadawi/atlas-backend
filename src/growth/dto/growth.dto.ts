/**
 * G1 — request DTOs of `platform-growth/*` (class-validator). The global
 * `ValidationPipe` refuses unknown keys; cross-field rules (season order,
 * hire thresholds, month ranges) are checked by the services after
 * merging with the stored values.
 */
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  ACQUISITION_CHANNELS,
  SPEND_CHANNELS,
  type AcquisitionChannelValue,
  type SpendChannel,
} from '../../common/attribution/acquisition-channel';

/** `YYYY-MM`, 2020-01 … 2100-12. */
export const MONTH_PATTERN = /^(20[2-9]\d|2100)-(0[1-9]|1[0-2])$/;
/** `YYYY-MM-DD`; the calendar check is `isRealDate`. */
export const DATE_PATTERN = /^(20[2-9]\d|2100)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const GROWTH_LIMITS = {
  amountMinorUnits: { min: 1, max: 10_000_000_000 },
  description: { max: 200 },
  overrideNote: { max: 200 },
  weeklyOwnerHours: { min: 1, max: 80 },
  onboardingCapPerWeek: { min: 1, max: 50 },
  minutesPerOnboarding: { min: 15, max: 600 },
  supportMinutesPerPayingOrgPerWeek: { min: 0, max: 240 },
  hirePayingOrgs: { min: 1, max: 10_000 },
  rangeMonths: { max: 36 },
} as const;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Trimmed; an empty string becomes `null` (no description). */
const trimToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  return text.length === 0 ? null : text;
};

/** Present → validated; `null` is refused. */
const unlessUndefined = ValidateIf((_o: unknown, value: unknown) => value !== undefined);

/** A `YYYY-MM-DD` string that is a real calendar date (no 31 February). */
export function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export class MonthRangeQueryDto {
  @IsOptional()
  @Matches(MONTH_PATTERN)
  readonly from?: string;

  @IsOptional()
  @Matches(MONTH_PATTERN)
  readonly to?: string;
}

export class CreateSpendEntryDto {
  @Matches(MONTH_PATTERN)
  readonly month!: string;

  @IsIn(SPEND_CHANNELS)
  readonly channel!: SpendChannel;

  @IsInt()
  @Min(GROWTH_LIMITS.amountMinorUnits.min)
  @Max(GROWTH_LIMITS.amountMinorUnits.max)
  readonly amountMinorUnits!: number;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(GROWTH_LIMITS.description.max)
  readonly description?: string | null;
}

export class UpdateSpendEntryDto {
  @unlessUndefined
  @Matches(MONTH_PATTERN)
  readonly month?: string;

  @unlessUndefined
  @IsIn(SPEND_CHANNELS)
  readonly channel?: SpendChannel;

  @unlessUndefined
  @IsInt()
  @Min(GROWTH_LIMITS.amountMinorUnits.min)
  @Max(GROWTH_LIMITS.amountMinorUnits.max)
  readonly amountMinorUnits?: number;

  /** `null` or `''` clears it. */
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(GROWTH_LIMITS.description.max)
  readonly description?: string | null;

  /** Optimistic concurrency: the `version` the editor last read. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly version!: number;
}

export class UpdateGrowthSettingsDto {
  @unlessUndefined
  @Matches(DATE_PATTERN)
  readonly seasonStart?: string;

  @unlessUndefined
  @Matches(DATE_PATTERN)
  readonly seasonEnd?: string;

  @unlessUndefined
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 1 })
  @Min(GROWTH_LIMITS.weeklyOwnerHours.min)
  @Max(GROWTH_LIMITS.weeklyOwnerHours.max)
  readonly weeklyOwnerHours?: number;

  @unlessUndefined
  @IsInt()
  @Min(GROWTH_LIMITS.onboardingCapPerWeek.min)
  @Max(GROWTH_LIMITS.onboardingCapPerWeek.max)
  readonly onboardingCapPerWeek?: number;

  @unlessUndefined
  @IsInt()
  @Min(GROWTH_LIMITS.minutesPerOnboarding.min)
  @Max(GROWTH_LIMITS.minutesPerOnboarding.max)
  readonly minutesPerOnboarding?: number;

  @unlessUndefined
  @IsInt()
  @Min(GROWTH_LIMITS.supportMinutesPerPayingOrgPerWeek.min)
  @Max(GROWTH_LIMITS.supportMinutesPerPayingOrgPerWeek.max)
  readonly supportMinutesPerPayingOrgPerWeek?: number;

  @unlessUndefined
  @IsInt()
  @Min(GROWTH_LIMITS.hirePayingOrgs.min)
  @Max(GROWTH_LIMITS.hirePayingOrgs.max)
  readonly hireWarnPayingOrgs?: number;

  @unlessUndefined
  @IsInt()
  @Min(GROWTH_LIMITS.hirePayingOrgs.min)
  @Max(GROWTH_LIMITS.hirePayingOrgs.max)
  readonly hireNowPayingOrgs?: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly version!: number;
}

export class SetOrganizationChannelDto {
  /** `null` clears the override. Required (send `null` explicitly to clear). */
  @ValidateIf((_o: unknown, value: unknown) => value !== null)
  @IsIn(ACQUISITION_CHANNELS)
  readonly channel!: AcquisitionChannelValue | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(GROWTH_LIMITS.overrideNote.max)
  readonly note?: string | null;
}
