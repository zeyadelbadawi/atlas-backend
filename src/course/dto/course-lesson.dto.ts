/** Lesson create/update requests — match `CreateCourseLessonPayload`/`UpdateCourseLessonPayload` (`course.types.ts`). Same "no `order` field, append-only" rule as sections. */
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import {
  COURSE_LESSON_CONTENT_TYPE_VALUES,
  COURSE_LESSON_STATUS_VALUES,
  MAX_LESSON_DESCRIPTION_LENGTH,
  MAX_LESSON_TITLE_LENGTH,
} from './course.constants';

export class CreateCourseLessonDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_LESSON_TITLE_LENGTH)
  readonly title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_LESSON_DESCRIPTION_LENGTH)
  readonly description?: string;

  @IsNotEmpty()
  @IsIn(COURSE_LESSON_CONTENT_TYPE_VALUES)
  readonly contentType!: (typeof COURSE_LESSON_CONTENT_TYPE_VALUES)[number];

  @IsOptional()
  @IsUrl()
  readonly contentUrl?: string;

  @IsOptional()
  @IsIn(COURSE_LESSON_STATUS_VALUES)
  readonly status?: (typeof COURSE_LESSON_STATUS_VALUES)[number];
}

export class UpdateCourseLessonDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_LESSON_TITLE_LENGTH)
  readonly title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_LESSON_DESCRIPTION_LENGTH)
  readonly description?: string;

  @IsOptional()
  @IsIn(COURSE_LESSON_CONTENT_TYPE_VALUES)
  readonly contentType?: (typeof COURSE_LESSON_CONTENT_TYPE_VALUES)[number];

  @IsOptional()
  @IsUrl()
  readonly contentUrl?: string;

  @IsOptional()
  @IsIn(COURSE_LESSON_STATUS_VALUES)
  readonly status?: (typeof COURSE_LESSON_STATUS_VALUES)[number];
}
