/** Lesson create/update requests — match `CreateCourseLessonPayload`/`UpdateCourseLessonPayload` (`course.types.ts`). Same "no `order` field, append-only" rule as sections. */
import {
  IsBoolean,
  IsISO8601,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateIf,
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

  /**
   * P64 Phase 2 — the protected video this lesson plays.
   *
   * THE WRITE PATH THE PHASE WAS MISSING. `course_lessons.video_asset_id`
   * was added, read by the grant path, the sequence and the playback
   * evidence — and written by nothing, so no lesson could ever have a
   * video and the entire hosted-video path was unreachable in practice.
   *
   * `null` detaches. The service verifies the asset belongs to THIS
   * academy before linking it, so a caller cannot attach another tenant's
   * video by guessing an id.
   */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  readonly videoAssetId?: string | null;

  /** P64 Phase 2 — a sample lesson, readable without an enrollment (§D.3). */
  @IsOptional()
  @IsBoolean()
  readonly isPreview?: boolean;

  /** P64 Phase 2 — drip date. A future value locks the lesson with reason `scheduled`, for enrolled students too. */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsISO8601()
  readonly availableAt?: string | null;

  /**
   * P64 Phase 2 — how this lesson may be completed.
   *
   * `watched_ratio` additionally requires server-recorded evidence that
   * enough of the video was actually watched; the button is still there,
   * but it refuses below the minimum.
   */
  @IsOptional()
  @IsIn(['manual', 'watched_ratio'])
  readonly completionRule?: 'manual' | 'watched_ratio';
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

  /**
   * P64 Phase 2 — the protected video this lesson plays. `null` detaches.
   *
   * The service verifies the asset belongs to THIS academy before
   * linking, so a caller cannot attach another tenant's video by guessing
   * an id.
   */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  readonly videoAssetId?: string | null;

  /** P64 Phase 2 — a sample lesson, readable without an enrollment (§D.3). */
  @IsOptional()
  @IsBoolean()
  readonly isPreview?: boolean;

  /** P64 Phase 2 — drip date; a future value locks the lesson with reason `scheduled`. */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsISO8601()
  readonly availableAt?: string | null;

  /** P64 Phase 2 — `watched_ratio` gates completion on server-recorded evidence. */
  @IsOptional()
  @IsIn(['manual', 'watched_ratio'])
  readonly completionRule?: 'manual' | 'watched_ratio';
}
