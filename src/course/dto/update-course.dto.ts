/**
 * `PATCH /academies/:id/courses/:id` request — matches `UpdateCoursePayload`
 * (`course.types.ts`) field-for-field, EXCEPT `status`.
 *
 * `status` is deliberately absent: a course's lifecycle moves only through
 * the dedicated `publish`/`unpublish`/archive (`DELETE`) endpoints, which
 * are the controlled transitions (`CoursesService.setPublicationState`,
 * its readiness hook and its audit rows). Accepting `status` here let a
 * plain field edit publish or archive a course past all of that (the
 * bypass `course-readiness.ts` flagged). With the global
 * `forbidNonWhitelisted` pipe a `status` key is now a 400, never a silent
 * no-op. The dashboard's course editor never sends it.
 */
import {
  ArrayMaxSize,
  IsArray,
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
  COURSE_LEVEL_VALUES,
  COURSE_SLUG_REGEX,
  COURSE_VISIBILITY_VALUES,
  MAX_COURSE_DESCRIPTION_LENGTH,
  MAX_COURSE_LANGUAGE_LENGTH,
  MAX_COURSE_OUTCOME_LENGTH,
  MAX_COURSE_OUTCOMES,
  MAX_COURSE_REQUIREMENT_LENGTH,
  MAX_COURSE_REQUIREMENTS,
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

  // ---- P64 Phase 4 catalog metadata ----

  @IsOptional()
  @IsIn(COURSE_LEVEL_VALUES)
  readonly level?: (typeof COURSE_LEVEL_VALUES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(MAX_COURSE_LANGUAGE_LENGTH)
  readonly language?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_COURSE_OUTCOMES)
  @IsString({ each: true })
  @MaxLength(MAX_COURSE_OUTCOME_LENGTH, { each: true })
  readonly outcomes?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_COURSE_REQUIREMENTS)
  @IsString({ each: true })
  @MaxLength(MAX_COURSE_REQUIREMENT_LENGTH, { each: true })
  readonly requirements?: string[];

  @IsOptional()
  @IsString()
  readonly introVideoAssetId?: string;
}
