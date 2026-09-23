/**
 * `POST /academies/:id/courses` request — matches `CreateCoursePayload`
 * (`course.types.ts`) field-for-field. Validation floors mirror the
 * frontend's own `createCourseSchema` (`course.schemas.ts`) exactly.
 */
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
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

// See `RegisterDto`'s comment (identity module): `@IsNotEmpty()` is what
// actually rejects a missing required field; class-validator's other
// decorators silently skip `undefined`.
export class CreateCourseDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_COURSE_TITLE_LENGTH)
  readonly title!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_COURSE_SLUG_LENGTH)
  @Matches(COURSE_SLUG_REGEX, { message: 'errors.course.invalidSlug' })
  readonly slug!: string;

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

  @IsNotEmpty()
  @IsObject()
  @ValidateNested()
  @Type(() => CoursePricingInputDto)
  readonly pricing!: CoursePricingInputDto;

  @IsNotEmpty()
  @IsIn(COURSE_VISIBILITY_VALUES)
  readonly visibility!: (typeof COURSE_VISIBILITY_VALUES)[number];

  // ---- P64 Phase 4 catalog metadata (all optional at authoring time) ----

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
