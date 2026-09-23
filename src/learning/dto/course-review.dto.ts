/**
 * Course review request contracts (P64 Phase 4, master plan §D.4).
 *
 * A review is authored by an ENROLLED learner (one per course+student,
 * enforced by the `@@unique([courseId, studentId])` on `CourseReview` and
 * the `course_reviews_self_insert` RLS policy) and then MODERATED by the
 * course's reviewer (instructor / owner / manager). The rating is a whole
 * 1–5; the body is optional free text bounded here and sanitized in the
 * service before it is stored.
 */
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';

export const COURSE_REVIEW_STATUS_VALUES = ['pending', 'approved', 'rejected'] as const;

export const COURSE_REVIEW_MIN_RATING = 1;
export const COURSE_REVIEW_MAX_RATING = 5;
export const MAX_COURSE_REVIEW_BODY_LENGTH = 2000;

export class CreateCourseReviewDto {
  @IsInt()
  @Min(COURSE_REVIEW_MIN_RATING)
  @Max(COURSE_REVIEW_MAX_RATING)
  readonly rating!: number;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_COURSE_REVIEW_BODY_LENGTH)
  readonly body?: string;
}

export class UpdateCourseReviewDto {
  @IsOptional()
  @IsInt()
  @Min(COURSE_REVIEW_MIN_RATING)
  @Max(COURSE_REVIEW_MAX_RATING)
  readonly rating?: number;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_COURSE_REVIEW_BODY_LENGTH)
  readonly body?: string;
}

/** Moderation list query — the shared page/pageSize plus an optional status filter. */
export class ListCourseReviewsQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(COURSE_REVIEW_STATUS_VALUES)
  readonly status?: (typeof COURSE_REVIEW_STATUS_VALUES)[number];
}
