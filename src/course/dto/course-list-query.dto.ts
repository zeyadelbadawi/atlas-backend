/**
 * `GET /academies/:id/courses` query contract — matches `CourseListQuery`
 * (`course.types.ts`): the shared `CollectionQuery` base plus
 * `CourseFilters` (`status`/`visibility`/`categoryId`/`pricingType`),
 * flattened to top-level query params matching
 * `toCollectionParams`/`request.utils.ts`'s wire convention exactly
 * (filters are sent flat, not nested under a `filters` key).
 */
import { IsIn, IsOptional, IsString } from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import {
  COURSE_PRICING_TYPE_VALUES,
  COURSE_STATUS_VALUES,
  COURSE_VISIBILITY_VALUES,
} from './course.constants';

export class CourseListQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(COURSE_STATUS_VALUES)
  readonly status?: (typeof COURSE_STATUS_VALUES)[number];

  @IsOptional()
  @IsIn(COURSE_VISIBILITY_VALUES)
  readonly visibility?: (typeof COURSE_VISIBILITY_VALUES)[number];

  @IsOptional()
  @IsString()
  readonly categoryId?: string;

  @IsOptional()
  @IsIn(COURSE_PRICING_TYPE_VALUES)
  readonly pricingType?: (typeof COURSE_PRICING_TYPE_VALUES)[number];
}
