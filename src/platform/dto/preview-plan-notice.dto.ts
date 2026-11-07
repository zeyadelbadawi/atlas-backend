/**
 * `POST platform-plans/:key/notice-preview` request (B8 (UX audit) V08).
 *
 * The plan editor's proposed price and/or limits, before saving, so the
 * confirmation can say how many organizations the save will email. The
 * same validation as `UpdatePlanDto`'s `pricing`/`limits` (each price's
 * range here, the cross-field and limit rules in the service), so a value
 * the save would refuse is refused here too. A facet that is omitted is
 * read as unchanged.
 */
import { Type } from 'class-transformer';
import { IsObject, IsOptional, ValidateNested } from 'class-validator';
import { PlanPricingDto } from './update-plan.dto';

export class PreviewPlanNoticeDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => PlanPricingDto)
  readonly pricing?: PlanPricingDto;

  @IsOptional()
  @IsObject()
  readonly limits?: Record<string, number | 'unlimited'>;
}
