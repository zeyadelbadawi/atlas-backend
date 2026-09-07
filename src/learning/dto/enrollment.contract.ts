/**
 * `Enrollment` response contract — matches `enrollment.types.ts`
 * field-for-field.
 */
import type {
  Course as PrismaCourse,
  CourseCategory as PrismaCourseCategory,
  CourseInstructor as PrismaCourseInstructor,
  CourseProgress as PrismaCourseProgress,
  Enrollment as PrismaEnrollment,
  User,
} from '@prisma/client';
import { toCourseResponse } from '../../course/dto/course.contract';
import type { CourseResponse } from '../../course/dto/course.contract';

/**
 * A slim progress summary for list views (My Learning) — real totals only,
 * never the per-lesson/per-section breakdown `CourseProgressResponse`
 * carries (that's only needed once a student is actually inside the
 * course's own progress/curriculum view). Reuses the same
 * `CourseProgressRepository` row `CourseProgressService` already
 * maintains — no new materialization path, no denormalized copy.
 */
export interface EnrollmentProgressSummary {
  readonly totalLessons: number;
  readonly completedLessons: number;
  readonly percentage: number;
  readonly currentLessonId?: string;
  readonly completionState: PrismaCourseProgress['completionState'];
  readonly certificateStatus: PrismaCourseProgress['certificateStatus'];
}

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
  /**
   * Only populated by `EnrollmentsService.list` (My Learning) — the LMS UX
   * pass's own real gap: a progress bar/"continue learning" CTA needs
   * real completion data, not just the enrollment's own coarse `status`
   * enum. Absent wherever `course` above is absent, for the same reason.
   */
  readonly progress?: EnrollmentProgressSummary;
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
  progress?: PrismaCourseProgress,
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
    progress: progress
      ? {
          totalLessons: progress.totalLessons,
          completedLessons: progress.completedLessons,
          percentage: Number(progress.percentage),
          currentLessonId: progress.currentLessonId ?? undefined,
          completionState: progress.completionState,
          certificateStatus: progress.certificateStatus,
        }
      : undefined,
  };
}
