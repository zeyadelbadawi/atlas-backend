/** Matches `CoursePricing` (`course.types.ts`) — the request-side shape of `CreateCoursePayload.pricing`/`UpdateCoursePayload.pricing`. `amount` arrives as a plain decimal number; see `course.contract.ts` for the minor-units bridge on the way back out. */
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  ValidateIf,
} from 'class-validator';
import { COURSE_PRICING_TYPE_VALUES } from './course.constants';

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
  readonly amount?: number;

  @IsOptional()
  @IsString()
  readonly currency?: string;
}
