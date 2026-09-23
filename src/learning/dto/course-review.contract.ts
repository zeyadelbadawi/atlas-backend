import type { CourseReview as PrismaCourseReview } from '@prisma/client';

/**
 * A single course review, as returned to the author, a moderator, or the
 * public (approved only). `studentName` is present only on the moderator
 * and self views — the public approved list carries it too (reviews are a
 * public signal), but never the email or any other PII beyond the display
 * name; `studentId` is included for the author's own row and moderation.
 */
export interface CourseReviewResponse {
  readonly id: string;
  readonly courseId: string;
  readonly studentId: string;
  readonly studentName?: string;
  readonly rating: number;
  readonly body?: string;
  readonly status: PrismaCourseReview['status'];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CourseReviewWithStudent = PrismaCourseReview & {
  student?: { id: string; name: string | null } | null;
};

export function toCourseReviewResponse(
  review: CourseReviewWithStudent,
): CourseReviewResponse {
  return {
    id: review.id,
    courseId: review.courseId,
    studentId: review.studentId,
    studentName: review.student?.name ?? undefined,
    rating: review.rating,
    body: review.body ?? undefined,
    status: review.status,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
  };
}

/**
 * The aggregate signal a catalog/course-details page renders: how many
 * APPROVED reviews exist, their mean (rounded to one decimal), and the
 * per-star histogram. Computed only over `status = 'approved'` rows so a
 * pending or rejected review never moves the public number.
 */
export interface CourseRatingSummary {
  readonly courseId: string;
  readonly averageRating: number;
  readonly totalReviews: number;
  /** Count per star, keyed '1'..'5'. */
  readonly distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

export function buildRatingSummary(
  courseId: string,
  ratings: readonly number[],
): CourseRatingSummary {
  const distribution: Record<'1' | '2' | '3' | '4' | '5', number> = {
    '1': 0,
    '2': 0,
    '3': 0,
    '4': 0,
    '5': 0,
  };
  let sum = 0;
  for (const r of ratings) {
    sum += r;
    const key = String(r) as '1' | '2' | '3' | '4' | '5';
    if (key in distribution) distribution[key] += 1;
  }
  const total = ratings.length;
  const average = total === 0 ? 0 : Math.round((sum / total) * 10) / 10;
  return {
    courseId,
    averageRating: average,
    totalReviews: total,
    distribution,
  };
}
