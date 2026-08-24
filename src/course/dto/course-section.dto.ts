/** Section create/update requests — match `CreateCourseSectionPayload`/`UpdateCourseSectionPayload` (`course.types.ts`). Neither carries an `order` field — a new section is always appended last; ordering changes go through the dedicated reorder endpoint only (see `ReorderItemsDto`). */
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  MAX_SECTION_DESCRIPTION_LENGTH,
  MAX_SECTION_TITLE_LENGTH,
} from './course.constants';

export class CreateCourseSectionDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_SECTION_TITLE_LENGTH)
  readonly title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SECTION_DESCRIPTION_LENGTH)
  readonly description?: string;
}

export class UpdateCourseSectionDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SECTION_TITLE_LENGTH)
  readonly title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SECTION_DESCRIPTION_LENGTH)
  readonly description?: string;
}
