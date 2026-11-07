/**
 * Body for PATCH platform-add-ons/:key/pricing (plan management, item 9).
 *
 * The add-on's price for NEW purchases. A checkout freezes the price it
 * was created with and a payment copies it, so editing never changes a
 * past charge; installed add-ons have no renewal, so nobody who already
 * has it is charged again.
 *
 * - `amount`: whole currency units, 1..1,000,000 (the plan price bounds).
 *   Never 0: a priced add-on goes through checkout, a free one installs
 *   directly, so clearing the price would make a paid add-on free.
 * - `currency`: a supported currency (EGP, owner decision): an add-on
 *   priced in another currency is moved to EGP by its next price edit.
 * - The billing cycle stays as stored.
 */
import { IsInt, IsString, Matches, Min } from 'class-validator';
import { IsIntInRange } from '../../common/validation/violation-message';
import { PLAN_PRICE_MAX, PLAN_PRICE_MIN } from './update-plan.dto';

export class UpdateAddOnPricingDto {
  @IsIntInRange(PLAN_PRICE_MIN, PLAN_PRICE_MAX)
  readonly amount!: number;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  readonly currency!: string;

  @IsInt()
  @Min(0)
  readonly expectedVersion!: number;
}
