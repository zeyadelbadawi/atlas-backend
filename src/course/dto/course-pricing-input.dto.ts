/** Matches `CoursePricing` (`course.types.ts`) — the request-side shape of `CreateCoursePayload.pricing`/`UpdateCoursePayload.pricing`. `amount` arrives as a plain decimal number; see `course.contract.ts` for the minor-units bridge on the way back out. */
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  ValidateIf,
} from 'class-validator';
import { withViolation } from '../../common/validation/violation-message';
import { COURSE_PRICING_TYPE_VALUES } from './course.constants';

/**
 * B3 (UX audit) — the highest price a course can be given, in the course's
 * currency: the same maximum the dashboard's price field enforces
 * (`MAX_COURSE_PRICE`, atlas `price-input.utils.ts`). Above it the field
 * gets the frontend's own message, with the maximum written the way the
 * form writes it.
 */
export const MAX_COURSE_PRICE = 1_000_000;
const PRICE_TOO_HIGH = withViolation('course:validation.priceTooHigh', {
  max: MAX_COURSE_PRICE.toLocaleString('en-US'),
});

export class CoursePricingInputDto {
  @IsNotEmpty()
  @IsIn(COURSE_PRICING_TYPE_VALUES)
  readonly type!: (typeof COURSE_PRICING_TYPE_VALUES)[number];

  // Required, and must be a positive number, exactly when `type` is `paid` —
  // mirrors the frontend's own `createCourseSchema`/`updateCourseSchema`
  // `.refine()` (course.schemas.ts): "pricingType !== 'paid' || (amount is a
  // number && amount > 0)". The frontend already enforces this client-side;
  // this is the same "never trust the client-side check alone" discipline
  // applied everywhere else in this codebase — without it, a direct API
  // call could persist a `paid` course with no price at all.
  @ValidateIf((o: CoursePricingInputDto) => o.type === 'paid')
  @IsNumber()
  @IsPositive()
  @Max(MAX_COURSE_PRICE, PRICE_TOO_HIGH)
  readonly amount?: number;

  // D5-3 — optional: a paid price sent without one keeps the course's
  // current currency, or takes the academy's (`CoursesService`).
  @IsOptional()
  @IsString()
  readonly currency?: string;
}
