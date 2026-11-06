/**
 * B0-BIL-06 — request bodies for the Platform Owner's audited subscription
 * remedies. Every remedy carries a written reason: these actions change
 * what a customer is entitled to outside the payment flow, so the audit
 * row must say why, in words a second person can check later.
 */
import { Transform } from 'class-transformer';
import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { IsIntInRange, withViolation } from '../../common/validation/violation-message';

export const ADJUSTMENT_REASON_MIN_LENGTH = 10;
export const ADJUSTMENT_REASON_MAX_LENGTH = 500;
/** One year at a time. A longer remedy is a plan or pricing decision, not an adjustment. */
export const ADJUSTMENT_MAX_DAYS = 365;

/**
 * B8 (UX audit) V05/V12 — the reason is trimmed before validation (ten
 * spaces are not a reason), and both rules name their own violation with
 * the numbers in it: `days` gets `errors.platform.subscriptionAdjustment.
 * daysRange` `{ min: 1, max: 365 }` and `reason` gets `…reasonTooShort`
 * `{ count: 10 }`. Their custom `message` alone never reached the client
 * (see `violation-message.ts`), which got a bare `validation:min`.
 */
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const REASON_TOO_SHORT = withViolation(
  'errors.platform.subscriptionAdjustment.reasonTooShort',
  { count: ADJUSTMENT_REASON_MIN_LENGTH },
);

export class SubscriptionDaysAdjustmentDto {
  @IsIntInRange(
    1,
    ADJUSTMENT_MAX_DAYS,
    'errors.platform.subscriptionAdjustment.daysRange',
  )
  readonly days!: number;

  @Transform(trim)
  @IsString()
  @MinLength(ADJUSTMENT_REASON_MIN_LENGTH, REASON_TOO_SHORT)
  @MaxLength(ADJUSTMENT_REASON_MAX_LENGTH)
  readonly reason!: string;
}

const PLAN_REQUIRED = withViolation(
  'errors.platform.subscriptionAdjustment.planRequired',
);

export const PLAN_CHANGE_APPLY_AT = ['now', 'period_end'] as const;
export type PlanChangeApplyAt = (typeof PLAN_CHANGE_APPLY_AT)[number];

export class SubscriptionPlanChangeDto {
  // Looser than `CreatePlanDto.key` on purpose: it must also name plans
  // seeded before that rule existed. Missing, empty or malformed is
  // `…planRequired` on this field; the service looks the key up exactly and
  // answers an unknown one on this field too (`…planNotFound`).
  @IsString(PLAN_REQUIRED)
  @Matches(/^[A-Za-z0-9_-]{1,100}$/, PLAN_REQUIRED)
  readonly planKey!: string;

  @IsIn(PLAN_CHANGE_APPLY_AT)
  readonly applyAt!: PlanChangeApplyAt;

  @Transform(trim)
  @IsString()
  @MinLength(ADJUSTMENT_REASON_MIN_LENGTH, REASON_TOO_SHORT)
  @MaxLength(ADJUSTMENT_REASON_MAX_LENGTH)
  readonly reason!: string;
}
