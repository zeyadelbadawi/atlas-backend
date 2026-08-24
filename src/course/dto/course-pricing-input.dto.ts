/** Matches `CoursePricing` (`course.types.ts`) — the request-side shape of `CreateCoursePayload.pricing`/`UpdateCoursePayload.pricing`. `amount` arrives as a plain decimal number; see `course.contract.ts` for the minor-units bridge on the way back out. */
import { IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { COURSE_PRICING_TYPE_VALUES } from './course.constants';

export class CoursePricingInputDto {
  @IsNotEmpty()
  @IsIn(COURSE_PRICING_TYPE_VALUES)
  readonly type!: (typeof COURSE_PRICING_TYPE_VALUES)[number];

  @IsOptional()
  @IsNumber()
  @Min(0)
  readonly amount?: number;

  @IsOptional()
  @IsString()
  readonly currency?: string;
}
