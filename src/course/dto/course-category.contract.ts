/**
 * `CourseCategory` response contract — matches `course.types.ts`
 * field-for-field. `courseCount` is real, computed from `courses` (never
 * a stored counter, avoiding drift) — present whenever the caller asked
 * for it (see `CoursesCategoriesService`), matching the frontend field's
 * own "when the backend reports it" doc comment (optional by design).
 */
import type { CourseCategory as PrismaCourseCategory } from '@prisma/client';

export interface CourseCategoryResponse {
  readonly id: string;
  readonly academyId: string;
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  readonly courseCount?: number;
}

export function toCourseCategoryResponse(
  category: PrismaCourseCategory,
  courseCount?: number,
): CourseCategoryResponse {
  return {
    id: category.id,
    academyId: category.academyId,
    name: category.name,
    slug: category.slug,
    description: category.description ?? undefined,
    courseCount,
  };
}
