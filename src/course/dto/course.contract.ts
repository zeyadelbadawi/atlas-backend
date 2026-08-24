/**
 * `Course` response contract — matches `course.types.ts` field-for-field.
 *
 * Pricing bridge: see `schema.prisma`'s doc comment on the `Course` model
 * for why `pricingAmountMinorUnits` (integer cents, at rest) converts to
 * `pricing.amount` (a plain decimal number, matching `CoursePricing`'s
 * actual frontend shape) here, in the response mapper, and nowhere else.
 */
import type {
  Course as PrismaCourse,
  CourseCategory as PrismaCourseCategory,
  CourseInstructor as PrismaCourseInstructor,
  User,
} from '@prisma/client';
import { toCourseCategoryResponse } from './course-category.contract';
import type { CourseCategoryResponse } from './course-category.contract';

export interface CoursePricingResponse {
  readonly type: PrismaCourse['pricingType'];
  readonly amount?: number;
  readonly currency?: string;
}

export interface CourseInstructorSummaryResponse {
  readonly id: string;
  readonly name: string;
  readonly avatar?: string;
}

export interface CourseStatsResponse {
  readonly totalSections: number;
  readonly totalLessons: number;
}

export interface CourseResponse {
  readonly id: string;
  readonly academyId: string;
  readonly title: string;
  readonly slug: string;
  readonly description?: string;
  readonly shortDescription?: string;
  readonly thumbnail?: string;
  readonly status: PrismaCourse['status'];
  readonly visibility: PrismaCourse['visibility'];
  readonly pricing: CoursePricingResponse;
  readonly categoryId?: string;
  readonly category?: CourseCategoryResponse;
  readonly instructors: readonly CourseInstructorSummaryResponse[];
  readonly stats?: CourseStatsResponse;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publishedAt?: string;
}

/** `amount` at rest is integer minor units (cents); the wire contract is a plain decimal — divide by 100, never expose the raw integer. */
function toPricingResponse(course: PrismaCourse): CoursePricingResponse {
  return {
    type: course.pricingType,
    amount:
      course.pricingAmountMinorUnits !== null
        ? Number(course.pricingAmountMinorUnits) / 100
        : undefined,
    currency: course.pricingCurrency ?? undefined,
  };
}

export function toCourseResponse(
  course: PrismaCourse & {
    category?: PrismaCourseCategory | null;
    instructors?: (PrismaCourseInstructor & {
      user: Pick<User, 'id' | 'name' | 'avatarUrl'>;
    })[];
  },
  stats?: CourseStatsResponse,
): CourseResponse {
  return {
    id: course.id,
    academyId: course.academyId,
    title: course.title,
    slug: course.slug,
    description: course.description ?? undefined,
    shortDescription: course.shortDescription ?? undefined,
    thumbnail: course.thumbnailUrl ?? undefined,
    status: course.status,
    visibility: course.visibility,
    pricing: toPricingResponse(course),
    categoryId: course.categoryId ?? undefined,
    category: course.category ? toCourseCategoryResponse(course.category) : undefined,
    instructors: (course.instructors ?? []).map((instructor) => ({
      id: instructor.user.id,
      name: instructor.user.name,
      avatar: instructor.user.avatarUrl ?? undefined,
    })),
    stats,
    createdAt: course.createdAt.toISOString(),
    updatedAt: course.updatedAt.toISOString(),
    publishedAt: course.publishedAt?.toISOString(),
  };
}
