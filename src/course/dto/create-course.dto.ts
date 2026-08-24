/**
 * `POST /academies/:id/courses` request — matches `CreateCoursePayload`
 * (`course.types.ts`) field-for-field. Validation floors mirror the
 * frontend's own `createCourseSchema` (`course.schemas.ts`) exactly.
 */
import {
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
  COURSE_SLUG_REGEX,
  COURSE_VISIBILITY_VALUES,
  MAX_COURSE_DESCRIPTION_LENGTH,
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
}
