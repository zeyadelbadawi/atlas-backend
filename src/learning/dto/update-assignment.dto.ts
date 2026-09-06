/** `PATCH /courses/:id/assignments/:assignmentId` request (Phase 4, P24) — a general field update, matching `UpdateCourseDto`'s own shape. */
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  MAX_ASSIGNMENT_DESCRIPTION_LENGTH,
  MAX_ASSIGNMENT_INSTRUCTIONS_LENGTH,
  MAX_ASSIGNMENT_TITLE_LENGTH,
} from './learning.constants';

const ASSIGNMENT_STATUS_VALUES = ['draft', 'published'] as const;

export class UpdateAssignmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ASSIGNMENT_TITLE_LENGTH)
  readonly title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ASSIGNMENT_DESCRIPTION_LENGTH)
  readonly description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ASSIGNMENT_INSTRUCTIONS_LENGTH)
  readonly instructions?: string;

  @IsOptional()
  @IsString()
  readonly sectionId?: string;

  @IsOptional()
  @IsString()
  readonly lessonId?: string;

  @IsOptional()
  @IsIn(ASSIGNMENT_STATUS_VALUES)
  readonly status?: (typeof ASSIGNMENT_STATUS_VALUES)[number];

  @IsOptional()
  @IsISO8601()
  readonly dueAt?: string;

  @IsOptional()
  @IsBoolean()
  readonly allowResubmission?: boolean;
}
