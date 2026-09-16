/**
 * `PlatformCourseSummary`/`.Detail` — the Platform Owner's cross-tenant
 * course console (P60). Matches `platform-course.types.ts` (atlas frontend)
 * field-for-field and reuses the Prisma enums verbatim rather than
 * re-declaring a parallel vocabulary of statuses.
 *
 * TWO DELIBERATE NAMING DECISIONS.
 *
 * 1. `createdBy` is `null`, not a placeholder string. A course whose creator
 *    was never recorded reports that honestly; the frontend renders "Not
 *    recorded" rather than this layer inventing an attribution.
 *
 * 2. There is no "subscribed students" field. A course has ENROLLED students
 *    (`Enrollment`), COMPLETED students (`Enrollment.status = completed`) and
 *    PAID orders (`CourseOrder.status = paid`) — three existing, separately
 *    meaningful facts. Collapsing them into one invented word would be a new
 *    domain concept that nothing else in Atlas uses.
 */
import type { Course } from '@prisma/client';
import type {
  PlatformCourseDetailRow,
  PlatformCourseRow,
} from '../../course/repositories/courses.repository';

/** Who created a course, when that is actually known. */
export interface PlatformCourseCreatorResponse {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface PlatformCourseInstructorResponse {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl?: string;
}

export interface PlatformCourseSummaryResponse {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly status: Course['status'];
  readonly visibility: Course['visibility'];
  readonly pricingType: Course['pricingType'];
  readonly pricingAmount?: number;
  readonly pricingCurrency?: string;
  readonly academyId: string;
  readonly academyName: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly categoryName?: string;
  /** `null` — never a fabricated fallback. See this file's header. */
  readonly createdBy: PlatformCourseCreatorResponse | null;
  readonly enrolledStudents: number;
  readonly createdAt: string;
  readonly publishedAt?: string;
}

export interface PlatformCourseDetailResponse extends PlatformCourseSummaryResponse {
  readonly shortDescription?: string;
  readonly description?: string;
  readonly thumbnailUrl?: string;
  readonly updatedAt: string;
  readonly totalSections: number;
  readonly totalLessons: number;
  readonly completedStudents: number;
  /** Paid `CourseOrder`s — the existing commerce record, not a new one. */
  readonly paidOrders: number;
  readonly instructors: readonly PlatformCourseInstructorResponse[];
}

/**
 * `pricingAmountMinorUnits` is a `BigInt` in Postgres and would serialise to
 * `"79"` (a string) or throw straight out of `JSON.stringify`. Every other
 * Atlas money contract converts at this boundary; this does the same.
 */
function toMajorUnits(minorUnits: bigint | null): number | undefined {
  if (minorUnits === null) return undefined;
  return Number(minorUnits) / 100;
}

export function toPlatformCourseSummaryResponse(
  course: PlatformCourseRow,
): PlatformCourseSummaryResponse {
  return {
    id: course.id,
    title: course.title,
    slug: course.slug,
    status: course.status,
    visibility: course.visibility,
    pricingType: course.pricingType,
    pricingAmount: toMajorUnits(course.pricingAmountMinorUnits),
    pricingCurrency: course.pricingCurrency ?? undefined,
    academyId: course.academy.id,
    academyName: course.academy.name,
    organizationId: course.academy.organization.id,
    organizationName: course.academy.organization.name,
    categoryName: course.category?.name ?? undefined,
    createdBy: course.createdBy
      ? {
          id: course.createdBy.id,
          name: course.createdBy.name,
          email: course.createdBy.email,
        }
      : null,
    enrolledStudents: course._count.enrollments,
    createdAt: course.createdAt.toISOString(),
    publishedAt: course.publishedAt?.toISOString(),
  };
}

export function toPlatformCourseDetailResponse(
  course: PlatformCourseDetailRow,
  counts: {
    readonly totalSections: number;
    readonly totalLessons: number;
    readonly completedStudents: number;
    readonly paidOrders: number;
  },
): PlatformCourseDetailResponse {
  return {
    ...toPlatformCourseSummaryResponse(course),
    shortDescription: course.shortDescription ?? undefined,
    description: course.description ?? undefined,
    thumbnailUrl: course.thumbnailUrl ?? undefined,
    updatedAt: course.updatedAt.toISOString(),
    totalSections: counts.totalSections,
    totalLessons: counts.totalLessons,
    completedStudents: counts.completedStudents,
    paidOrders: counts.paidOrders,
    instructors: course.instructors.map((instructor) => ({
      id: instructor.user.id,
      name: instructor.user.name,
      avatarUrl: instructor.user.avatarUrl ?? undefined,
    })),
  };
}
