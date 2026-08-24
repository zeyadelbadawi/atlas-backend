/** `PATCH /academies/:id/courses/:id` request — matches `UpdateCoursePayload` (`course.types.ts`) field-for-field. `status` here is a general field update (any of the three enum values); the dedicated `publish`/`unpublish` endpoints are the controlled workflow transitions (see `CoursesService`). */
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  COURSE_SLUG_REGEX,
  COURSE_STATUS_VALUES,
  COURSE_VISIBILITY_VALUES,
  MAX_COURSE_DESCRIPTION_LENGTH,
  MAX_COURSE_SHORT_DESCRIPTION_LENGTH,
  MAX_COURSE_TITLE_LENGTH,
  MAX_COURSE_SLUG_LENGTH,
} from './course.constants';
import { CoursePricingInputDto } from './course-pricing-input.dto';

export class UpdateCourseDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_COURSE_TITLE_LENGTH)
  readonly title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_COURSE_SLUG_LENGTH)
  @Matches(COURSE_SLUG_REGEX, { message: 'errors.course.invalidSlug' })
  readonly slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_COURSE_SHORT_DESCRIPTION_LENGTH)
  readonly shortDescription?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_COURSE_DESCRIPTION_LENGTH)
  readonly description?: string;

  @IsOptional()
  @IsString()
  readonly thumbnail?: string;

  @IsOptional()
  @IsString()
  readonly categoryId?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CoursePricingInputDto)
  readonly pricing?: CoursePricingInputDto;

  @IsOptional()
  @IsIn(COURSE_VISIBILITY_VALUES)
  readonly visibility?: (typeof COURSE_VISIBILITY_VALUES)[number];

  @IsOptional()
  @IsIn(COURSE_STATUS_VALUES)
  readonly status?: (typeof COURSE_STATUS_VALUES)[number];
}
