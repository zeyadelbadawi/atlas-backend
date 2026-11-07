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
  LEGACY_PLAN_FEATURE_KEYS,
  OPTIONAL_PLAN_LIMIT_KEYS,
  PLAN_FEATURE_KEYS,
  PLAN_LIMIT_KEYS,
} from '../../plans/dto/entitlement.types';
import { PlanFamily, PlanTier } from '@prisma/client';
import type { FieldViolation } from '../../common/dto/api-error.dto';
import { IsIntInRange } from '../../common/validation/violation-message';
import { TRIAL_DAYS_MAX, TRIAL_DAYS_MIN } from '../../plans/dto/trial-policy.contract';

/**
 * B8 (UX audit) V04/V09 — plan prices are whole amounts in major units
 * (the stored `PlanPricingMetadata` shape; every seeded price is whole), so
 * a fraction is refused like any other non-whole number.
 *
 * The floor is 1, not 0. Atlas has no free plan: trials are the free
 * period (`trialEligible`/`trialDurationDays`, `trial_policy`), every
 * seeded plan carries a price, and a plan that must not be bought simply
 * has no `pricing` (checkout then answers `pricingUnavailable`). A `0`
 * typed into the editor would silently turn a paid plan into a free one.
 *
 * The ceilings are the ones this DTO already enforced: 1,000,000 for the
 * plan's own price and 10,000,000 for a whole year.
 */
export const PLAN_PRICE_MIN = 1;
export const PLAN_PRICE_MAX = 1_000_000;
export const PLAN_YEARLY_PRICE_MAX = 10_000_000;

/** B8 (UX audit) V10 — the smallest stored limit; "no limit" is the string `unlimited`, never `-1`. */
export const PLAN_LIMIT_MIN = 0;

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
    IsIntInRange(GIFTED_DAYS_MIN, GIFTED_DAYS_MAX, 'errors.plan.giftedDaysRange'),
  );
}

/** B8 (UX audit) V09 — a plan's own trial length: null (platform default) or 1..365 days. */
function IsPlanTrialDays(): PropertyDecorator {
  return applyDecorators(IsOptional(), IsIntInRange(TRIAL_DAYS_MIN, TRIAL_DAYS_MAX));
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
  @IsIntInRange(PLAN_PRICE_MIN, PLAN_PRICE_MAX)
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
   *
   * Never below the monthly `amount` (`planPricingViolations`): a year
   * cheaper than one month is a typo, not a discount.
   */
  @IsOptional()
  @IsIntInRange(PLAN_PRICE_MIN, PLAN_YEARLY_PRICE_MAX)
  readonly yearlyAmount?: number;
}

/**
 * `{limitKey: number | 'unlimited'}`. Validated key-by-key below rather
 * than with a decorator, because the value is a union of a bounded integer
 * and one literal string — `class-validator` has no single decorator for
 * that, and accepting anything would let a bad value reach the entitlement
 * resolver.
 *
 * B8 (UX audit) V10 — answered as field violations on `limits.<key>`
 * (they were English sentences in a `details` array no client received):
 * a value that is not a whole number of at least `PLAN_LIMIT_MIN` gets
 * `errors.plan.limitValue` with `{ min }`; "no limit" is `unlimited`.
 */
export function assertValidLimits(limits: Record<string, unknown>): FieldViolation[] {
  const violations: FieldViolation[] = [];
  const allowed = new Set<string>([...PLAN_LIMIT_KEYS, ...OPTIONAL_PLAN_LIMIT_KEYS]);
  for (const key of Object.keys(limits)) {
    if (!allowed.has(key)) {
      violations.push({ field: `limits.${key}`, messageKey: 'validation:invalid' });
    }
  }
  const checkValue = (key: string, value: unknown): void => {
    if (value === 'unlimited') return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < PLAN_LIMIT_MIN) {
      violations.push({
        field: `limits.${key}`,
        messageKey: 'errors.plan.limitValue',
        values: { min: PLAN_LIMIT_MIN },
      });
    }
  };
  // W3-compose — optional keys are validated when present, never required.
  for (const key of OPTIONAL_PLAN_LIMIT_KEYS) {
    if (limits[key] !== undefined) checkValue(key, limits[key]);
  }
  for (const key of PLAN_LIMIT_KEYS) {
    if (limits[key] === undefined) {
      violations.push({ field: `limits.${key}`, messageKey: 'validation:required' });
      continue;
    }
    checkValue(key, limits[key]);
  }
  return violations;
}

/**
 * `{featureKey: boolean}` — every key required, so a plan can never carry a
 * half-defined feature set.
 *
 * Keys in `LEGACY_PLAN_FEATURE_KEYS` are tolerated here, not reported: a
 * plan editor loaded before they were removed still sends them, and
 * refusing its save would block an unrelated pricing or limit edit. They
 * are never stored — the caller persists `pickPlanFeatures(features)`.
 * Any OTHER unknown key is still a typo and is rejected.
 */
export function assertValidFeatures(features: Record<string, unknown>): FieldViolation[] {
  const violations: FieldViolation[] = [];
  const allowed = new Set<string>(PLAN_FEATURE_KEYS);
  const legacy = new Set<string>(LEGACY_PLAN_FEATURE_KEYS);
  for (const key of Object.keys(features)) {
    if (legacy.has(key)) continue;
    if (!allowed.has(key)) {
      violations.push({ field: `features.${key}`, messageKey: 'validation:invalid' });
    }
  }
  for (const key of PLAN_FEATURE_KEYS) {
    if (typeof features[key] !== 'boolean') {
      violations.push({ field: `features.${key}`, messageKey: 'validation:invalid' });
    }
  }
  return violations;
}

/**
 * B8 (UX audit) V09 — rules across the price's fields (each field's own
 * range is on `PlanPricingDto`): a yearly price offered beside a monthly
 * one is never below that monthly price — `errors.plan.yearlyBelowMonthly`
 * on `pricing.yearlyAmount` with `{ min }`, the monthly amount.
 */
export function planPricingViolations(
  pricing: Pick<PlanPricingDto, 'amount' | 'billingCycle' | 'yearlyAmount'> | undefined,
): FieldViolation[] {
  if (!pricing || pricing.billingCycle !== 'monthly') return [];
  if (pricing.yearlyAmount === undefined || pricing.yearlyAmount === null) return [];
  if (pricing.yearlyAmount >= pricing.amount) return [];
  return [
    {
      field: 'pricing.yearlyAmount',
      messageKey: 'errors.plan.yearlyBelowMonthly',
      values: { min: pricing.amount },
    },
  ];
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

  /** null = the platform's trial policy length; else 1..365 days. */
  @IsPlanTrialDays()
  readonly trialDurationDays?: number | null;

  /** W8 — gifted setup days on a first monthly subscription. null/0 = none; else 5..15. */
  @IsGiftedDays()
  readonly giftedDaysMonthly?: number | null;

  /** W8 — gifted setup days on a first yearly subscription. null/0 = none; else 5..15. */
  @IsGiftedDays()
  readonly giftedDaysYearly?: number | null;

  /**
   * B0-BIL-11 — which family and tier the plan belongs to. Hidden plans
   * (founding price locks, Enterprise deals) must be able to say they are,
   * for example, an `enterprise` tier; without these an API-created plan
   * always got the database defaults (`normal` / `basic`).
   */
  @IsOptional()
  @IsIn(Object.values(PlanFamily))
  readonly family?: PlanFamily;

  @IsOptional()
  @IsIn(Object.values(PlanTier))
  readonly tier?: PlanTier;
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

  /** null = the platform's trial policy length; else 1..365 days. */
  @IsPlanTrialDays()
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

/**
 * Item 9 (plan management) — bring an archived plan back. `displayOrder`
 * decides where it returns: `0` keeps it hidden (buyable by key only),
 * any other position lists it for customers again.
 */
export class RestorePlanDto {
  @IsInt()
  @Min(0)
  readonly expectedVersion!: number;

  @IsIntInRange(0, 1000)
  readonly displayOrder!: number;
}
