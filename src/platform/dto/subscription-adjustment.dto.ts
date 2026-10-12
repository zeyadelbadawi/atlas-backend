/**
 * B0-BIL-06 — request bodies for the Platform Owner's audited subscription
 * remedies. Every remedy carries a written reason: these actions change
 * what a customer is entitled to outside the payment flow, so the audit
 * row must say why, in words a second person can check later.
 */
import {
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const ADJUSTMENT_REASON_MIN_LENGTH = 10;
export const ADJUSTMENT_REASON_MAX_LENGTH = 500;
/** One year at a time. A longer remedy is a plan or pricing decision, not an adjustment. */
export const ADJUSTMENT_MAX_DAYS = 365;

export class SubscriptionDaysAdjustmentDto {
  @IsInt({ message: 'errors.platform.subscriptionAdjustment.daysRange' })
  @Min(1, { message: 'errors.platform.subscriptionAdjustment.daysRange' })
  @Max(ADJUSTMENT_MAX_DAYS, {
    message: 'errors.platform.subscriptionAdjustment.daysRange',
  })
  readonly days!: number;

  @IsString()
  @MinLength(ADJUSTMENT_REASON_MIN_LENGTH, {
    message: 'errors.platform.subscriptionAdjustment.reasonTooShort',
  })
  @MaxLength(ADJUSTMENT_REASON_MAX_LENGTH)
  readonly reason!: string;
}

export const PLAN_CHANGE_APPLY_AT = ['now', 'period_end'] as const;
export type PlanChangeApplyAt = (typeof PLAN_CHANGE_APPLY_AT)[number];

export class SubscriptionPlanChangeDto {
  @IsString()
  // Looser than `CreatePlanDto.key` on purpose: it must also name plans
  // seeded before that rule existed. The service looks the key up exactly.
  @Matches(/^[A-Za-z0-9_-]{1,100}$/)
  readonly planKey!: string;

  @IsIn(PLAN_CHANGE_APPLY_AT)
  readonly applyAt!: PlanChangeApplyAt;

  @IsString()
  @MinLength(ADJUSTMENT_REASON_MIN_LENGTH, {
    message: 'errors.platform.subscriptionAdjustment.reasonTooShort',
  })
  @MaxLength(ADJUSTMENT_REASON_MAX_LENGTH)
  readonly reason!: string;
}
