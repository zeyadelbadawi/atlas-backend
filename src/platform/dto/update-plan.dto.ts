/**
 * Platform-Owner plan administration payloads (P57).
 *
 * VALIDATION IS AGAINST THE REAL ENTITLEMENT KEYS, never a free-form
 * object. `limits` and `features` are JSONB columns read directly by
 * `EntitlementService.computeEffectiveEntitlements`, so a typo'd key would
 * not fail loudly — it would silently become an entitlement nobody holds.
 * `PLAN_LIMIT_KEYS`/`PLAN_FEATURE_KEYS` are the same constants the
 * resolver iterates, so the DTO and the resolver cannot drift.
 *
 * EVERY WRITE CARRIES `expectedVersion`. Plans are a small catalog that two
 * Platform Owners can realistically open at once, and a silent last-write-
 * wins on pricing or limits is a billing-shaped mistake. Same contract as
 * `UpdateAddOnCatalogStatusDto` (P51) and the website page editor before
 * it: the version goes into the UPDATE's WHERE clause and the database
 * decides the race.
 */
import { applyDecorators } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  OPTIONAL_PLAN_LIMIT_KEYS,
  PLAN_FEATURE_KEYS,
  PLAN_LIMIT_KEYS,
} from '../../plans/dto/entitlement.types';

/** W8 — the configurable range of gifted setup days (mirrors the DB CHECK). */
export const GIFTED_DAYS_MIN = 5;
export const GIFTED_DAYS_MAX = 15;

/**
 * W8 — `null` (or omitted) or `0` means "no gift"; anything else must be a
 * whole number of days in 5..15. Mirrors `plans_gifted_days_*_range_chk`.
 */
function IsGiftedDays(): PropertyDecorator {
  return applyDecorators(
    IsOptional(),
    ValidateIf((_object: unknown, value: unknown) => value !== 0),
    IsInt({ message: 'errors.plan.giftedDaysRange' }),
    Min(GIFTED_DAYS_MIN, { message: 'errors.plan.giftedDaysRange' }),
    Max(GIFTED_DAYS_MAX, { message: 'errors.plan.giftedDaysRange' }),
  );
}

/** Mirrors `LocalizedText` (`{en, ar}`) — the P54 shape used by every bilingual field in Atlas. */
export class PlanLocalizedTextDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  readonly en!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  readonly ar!: string;
}

export class PlanPricingDto {
  /**
   * Major-unit amount, matching the existing `PlanPricingMetadata` shape
   * this column already stores (`{amount, currency, billingCycle}`). Note
   * this is DISPLAY/catalog pricing — a completed `Payment` snapshots its
   * own `amountMinorUnits`/`currency`, so editing this never rewrites what
   * a customer was actually charged.
   */
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  readonly amount!: number;

  /** ISO-4217, upper-case. */
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  readonly currency!: string;

  @IsIn(['monthly', 'yearly'])
  readonly billingCycle!: 'monthly' | 'yearly';

  /**
   * Optional price for a whole year, offered beside a MONTHLY price (2 Oct
   * 2026). Absent means the plan has no yearly option — the checkout then
   * refuses a yearly request, exactly as before. Set only by the Platform
   * Owner; a client never sends a price at checkout.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  readonly yearlyAmount?: number;
}

/**
 * `{limitKey: number | 'unlimited'}`. Validated key-by-key below rather
 * than with a decorator, because the value is a union of a bounded integer
 * and one literal string — `class-validator` has no single decorator for
 * that, and accepting anything would let a bad value reach the entitlement
 * resolver.
 */
export function assertValidLimits(limits: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const allowed = new Set<string>([...PLAN_LIMIT_KEYS, ...OPTIONAL_PLAN_LIMIT_KEYS]);
  for (const key of Object.keys(limits)) {
    if (!allowed.has(key)) errors.push(`limits.${key} is not a plan limit key`);
  }
  // W3-compose — optional keys are validated when present, never required.
  for (const key of OPTIONAL_PLAN_LIMIT_KEYS) {
    const value = limits[key];
    if (value === undefined || value === 'unlimited') continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      errors.push(`limits.${key} must be a non-negative integer or "unlimited"`);
    }
  }
  for (const key of PLAN_LIMIT_KEYS) {
    const value = limits[key];
    if (value === undefined) {
      errors.push(`limits.${key} is required`);
      continue;
    }
    if (value === 'unlimited') continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      errors.push(`limits.${key} must be a non-negative integer or "unlimited"`);
    }
  }
  return errors;
}

/** `{featureKey: boolean}` — every key required, so a plan can never carry a half-defined feature set. */
export function assertValidFeatures(features: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const allowed = new Set<string>(PLAN_FEATURE_KEYS);
  for (const key of Object.keys(features)) {
    if (!allowed.has(key)) errors.push(`features.${key} is not a plan feature key`);
  }
  for (const key of PLAN_FEATURE_KEYS) {
    if (typeof features[key] !== 'boolean') {
      errors.push(`features.${key} must be a boolean`);
    }
  }
  return errors;
}

export class CreatePlanDto {
  /**
   * Stable catalog identifier. IMMUTABLE AFTER CREATION and therefore only
   * accepted here: `add_ons.compatiblePlanKeys` references plans by KEY in
   * a `String[]` with no foreign key, so renaming a key would silently
   * orphan add-on compatibility. There is deliberately no `key` field on
   * `UpdatePlanDto`.
   */
  @IsNotEmpty()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'key must be lowercase alphanumeric with single hyphens',
  })
  @MaxLength(60)
  readonly key!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  readonly name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly description?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PlanLocalizedTextDto)
  readonly nameLocalized?: PlanLocalizedTextDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PlanLocalizedTextDto)
  readonly descriptionLocalized?: PlanLocalizedTextDto;

  /** `> 0` keeps it customer-facing; `0` hides it (`CUSTOMER_FACING_WHERE`). */
  @IsInt()
  @Min(0)
  @Max(1000)
  readonly displayOrder!: number;

  @IsObject()
  readonly limits!: Record<string, number | 'unlimited'>;

  @IsObject()
  readonly features!: Record<string, boolean>;

  @IsOptional()
  @ValidateNested()
  @Type(() => PlanPricingDto)
  readonly pricing?: PlanPricingDto;

  @IsOptional()
  @IsBoolean()
  readonly trialEligible?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  readonly trialDurationDays?: number | null;

  /** W8 — gifted setup days on a first monthly subscription. null/0 = none; else 5..15. */
  @IsGiftedDays()
  readonly giftedDaysMonthly?: number | null;

  /** W8 — gifted setup days on a first yearly subscription. null/0 = none; else 5..15. */
  @IsGiftedDays()
  readonly giftedDaysYearly?: number | null;
}

/** Every field optional — a partial edit must not require resending the whole plan. */
export class UpdatePlanDto {
  @IsInt()
  @Min(0)
  readonly expectedVersion!: number;

  @IsOptional()
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  readonly name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly description?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PlanLocalizedTextDto)
  readonly nameLocalized?: PlanLocalizedTextDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PlanLocalizedTextDto)
  readonly descriptionLocalized?: PlanLocalizedTextDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  readonly displayOrder?: number;

  @IsOptional()
  @IsObject()
  readonly limits?: Record<string, number | 'unlimited'>;

  @IsOptional()
  @IsObject()
  readonly features?: Record<string, boolean>;

  @IsOptional()
  @ValidateNested()
  @Type(() => PlanPricingDto)
  readonly pricing?: PlanPricingDto;

  @IsOptional()
  @IsBoolean()
  readonly trialEligible?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  readonly trialDurationDays?: number | null;

  /** W8 — gifted setup days on a first monthly subscription. null/0 = none; else 5..15. */
  @IsGiftedDays()
  readonly giftedDaysMonthly?: number | null;

  /** W8 — gifted setup days on a first yearly subscription. null/0 = none; else 5..15. */
  @IsGiftedDays()
  readonly giftedDaysYearly?: number | null;
}

export class ArchivePlanDto {
  @IsInt()
  @Min(0)
  readonly expectedVersion!: number;
}
