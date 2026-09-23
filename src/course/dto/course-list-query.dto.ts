/**
 * `GET /academies/:id/courses` query contract — matches `CourseListQuery`
 * (`course.types.ts`): the shared `CollectionQuery` base plus
 * `CourseFilters` (`status`/`visibility`/`categoryId`/`pricingType`),
 * flattened to top-level query params matching
 * `toCollectionParams`/`request.utils.ts`'s wire convention exactly
 * (filters are sent flat, not nested under a `filters` key).
 */
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import {
  COURSE_LEVEL_VALUES,
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

  // ---- P64 Phase 4 catalog v2 filters (public catalog) ----

  @IsOptional()
  @IsIn(COURSE_LEVEL_VALUES)
  readonly level?: (typeof COURSE_LEVEL_VALUES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(35)
  readonly language?: string;

  /** Minimum price in MINOR units (inclusive); paired with `pricingType=paid` or standalone. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  readonly priceMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  readonly priceMax?: number;

  /**
   * `mode:'selected'` — fetch exactly these course ids (e.g. a Featured block).
   * Sent as a comma-separated list or repeated `ids` params; bounded to 50.
   */
  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        : value,
  )
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  readonly ids?: string[];
}
