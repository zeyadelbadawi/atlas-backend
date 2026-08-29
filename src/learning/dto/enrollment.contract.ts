/**
 * `Enrollment` response contract — matches `enrollment.types.ts`
 * field-for-field.
 */
import type {
  Course as PrismaCourse,
  CourseCategory as PrismaCourseCategory,
  CourseInstructor as PrismaCourseInstructor,
  Enrollment as PrismaEnrollment,
  User,
} from '@prisma/client';
import { toCourseResponse } from '../../course/dto/course.contract';
import type { CourseResponse } from '../../course/dto/course.contract';

export interface EnrollmentResponse {
  readonly id: string;
  readonly studentId: string;
  readonly courseId: string;
  readonly academyId: string;
  readonly status: PrismaEnrollment['status'];
  readonly enrolledAt?: string;
  readonly completedAt?: string;
  /**
   * Only populated where the caller joined the course row (currently
   * `EnrollmentsService.list`, which powers the student's "My Learning"
   * view — a real UI/UX gap found during a real browser acceptance test:
   * the bare enrollment record has no title/thumbnail/pricing to render a
   * card with, so "My Learning" had nothing to consume even though the
   * list-my-enrollments endpoint itself already existed and was correctly
   * RLS-scoped). Absent on the single-enrollment lookups that don't need
   * it (`getForCourse`, `createEnrollment`), to avoid an unnecessary join
   * on every enroll click.
   */
  readonly course?: CourseResponse;
}

export function toEnrollmentResponse(
  enrollment: PrismaEnrollment & {
    course?: PrismaCourse & {
      category?: PrismaCourseCategory | null;
      instructors?: (PrismaCourseInstructor & {
        user: Pick<User, 'id' | 'name' | 'avatarUrl'>;
      })[];
    };
  },
): EnrollmentResponse {
  return {
    id: enrollment.id,
    studentId: enrollment.studentId,
    courseId: enrollment.courseId,
    academyId: enrollment.academyId,
    status: enrollment.status,
    enrolledAt: enrollment.enrolledAt?.toISOString(),
    completedAt: enrollment.completedAt?.toISOString(),
    course: enrollment.course ? toCourseResponse(enrollment.course) : undefined,
  };
}
