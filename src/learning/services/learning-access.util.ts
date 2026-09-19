/**
 * Shared course-access checks, used by `CourseProgressService`/
 * `QuizzesService`/`AssignmentsService`/`InstructorService`.
 *
 * `assertActiveEnrollment` answers "does this student have real, CURRENT
 * access to this course's content". P64 Phase 1 made "current" explicit:
 * an enrollment row in an active status is no longer enough — it must also
 * be unrevoked, unexpired, and the student's academy membership must be
 * active and unblocked (master plan Section H, conditions 3 and 7). The
 * course's own status/visibility is still deliberately NOT re-checked here
 * (that becomes a delivery-time check on the content grant in Phase 2).
 *
 * `assertCourseReadAccess` (definition reads) and
 * `assertCanAuthorCourseContent` (writes) are unchanged in meaning.
 * `assertCanReviewCourse` (P64 Phase 1) is the review/grading tier: the
 * course's instructor OR the owning academy's owner/administrator/manager —
 * exactly `can_review_course()` in the P64 migration; the two must agree.
 *
 * A missing/inactive enrollment surfaces as 404, not 403 — matches the
 * "draft/unreachable content looks like it doesn't exist" pattern already
 * established for academy-scoped content rather than confirming to an
 * unauthorized caller that a course/enrollment exists at all.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Enrollment, Prisma } from '@prisma/client';
import { ACTIVE_ENROLLMENT_STATUSES } from '../dto/learning.constants';
import type { EnrollmentsRepository } from '../repositories/enrollments.repository';
import type { CourseInstructorsRepository } from '../../course/repositories/course-instructors.repository';
import type { CoursesRepository } from '../../course/repositories/courses.repository';
import type { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import type { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';

/** The one rule for "this enrollment grants access right now" — shared by every reader below and by the roster/lifecycle code. */
export function isEnrollmentActive(
  enrollment: Pick<Enrollment, 'status' | 'revokedAt' | 'expiresAt'>,
  now: Date = new Date(),
): boolean {
  if (!(ACTIVE_ENROLLMENT_STATUSES as readonly string[]).includes(enrollment.status)) {
    return false;
  }
  if (enrollment.revokedAt) return false;
  if (enrollment.expiresAt && enrollment.expiresAt.getTime() <= now.getTime())
    return false;
  return true;
}

export async function assertActiveEnrollment(
  tx: Prisma.TransactionClient,
  enrollmentsRepository: EnrollmentsRepository,
  studentId: string,
  courseId: string,
  academyStudentsRepository?: AcademyStudentsRepository,
): Promise<Enrollment> {
  const enrollment = await enrollmentsRepository.findByStudentAndCourse(
    tx,
    studentId,
    courseId,
  );
  if (!enrollment || !isEnrollmentActive(enrollment)) {
    throw new NotFoundException({ messageKey: 'errors.notFound' });
  }
  if (academyStudentsRepository) {
    // A blocked or non-active academy membership ends course access for the
    // whole academy at once (Section H condition 7), independent of any
    // single enrollment's own lifecycle columns.
    const membership = await academyStudentsRepository.findForUserInAcademy(
      tx,
      enrollment.academyId,
      studentId,
    );
    if (!membership || membership.status !== 'active' || membership.blockedAt) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
  }
  return enrollment;
}

/**
 * Read-access check for the two quiz/assignment *definition* read paths
 * (`getQuizzes`/`getQuiz`, `getAssignments`/`getAssignment`) — deliberately
 * broader than `assertActiveEnrollment`: an authorized instructor reads
 * these through the exact same P6 endpoints a student does. Since P64
 * Phase 1 the owning academy's owner/administrator/manager pass too (they
 * review the same definitions their attempts/submissions belong to), which
 * is the `quizzes_author_select`/`assignments_author_select` RLS tier.
 */
export async function assertCourseReadAccess(
  tx: Prisma.TransactionClient,
  enrollmentsRepository: EnrollmentsRepository,
  courseInstructorsRepository: CourseInstructorsRepository,
  userId: string,
  courseId: string,
  reviewers?: {
    readonly coursesRepository: CoursesRepository;
    readonly academyMembersRepository: AcademyMembersRepository;
  },
  academyStudentsRepository?: AcademyStudentsRepository,
): Promise<void> {
  const [enrollment, isInstructor] = await Promise.all([
    enrollmentsRepository.findByStudentAndCourse(tx, userId, courseId),
    courseInstructorsRepository.isInstructor(tx, courseId, userId),
  ]);
  let hasActiveEnrollment = !!enrollment && isEnrollmentActive(enrollment);
  if (hasActiveEnrollment && enrollment && academyStudentsRepository) {
    // P64 Phase 1 — a blocked or non-active academy membership ends access
    // to every course of that academy, exactly like `assertActiveEnrollment`.
    const membership = await academyStudentsRepository.findForUserInAcademy(
      tx,
      enrollment.academyId,
      userId,
    );
    hasActiveEnrollment =
      !!membership && membership.status === 'active' && !membership.blockedAt;
  }

  if (hasActiveEnrollment || isInstructor) return;

  if (reviewers) {
    const course = await reviewers.coursesRepository.findById(tx, courseId);
    if (course) {
      const membership = await reviewers.academyMembersRepository.findForUserInAcademy(
        tx,
        course.academyId,
        userId,
      );
      if (
        membership &&
        membership.status === 'active' &&
        MANAGING_ROLES.has(membership.role)
      ) {
        return;
      }
    }
  }

  throw new NotFoundException({ messageKey: 'errors.notFound' });
}

/** See `AcademiesService.MANAGING_ROLES`/`CoursesService.MANAGING_ROLES` — identical rule. */
const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

/**
 * Write-authorization check for Quiz/Assignment authoring (Phase 4, P24):
 * the course's own assigned instructor(s), OR the owning academy's
 * owner/administrator/manager — matches `can_author_course_content()`
 * (the P24 migration's RLS function) exactly. Returns the course's
 * `academyId`. A missing course or a real user with no authoring
 * relationship to it both surface as 404.
 */
export async function assertCanAuthorCourseContent(
  tx: Prisma.TransactionClient,
  coursesRepository: CoursesRepository,
  academyMembersRepository: AcademyMembersRepository,
  courseInstructorsRepository: CourseInstructorsRepository,
  userId: string,
  courseId: string,
): Promise<string> {
  const course = await coursesRepository.findById(tx, courseId);
  if (!course) {
    throw new NotFoundException({ messageKey: 'errors.notFound' });
  }

  const [membership, isInstructor] = await Promise.all([
    academyMembersRepository.findForUserInAcademy(tx, course.academyId, userId),
    courseInstructorsRepository.isInstructor(tx, courseId, userId),
  ]);
  const canManage = !!membership && MANAGING_ROLES.has(membership.role);

  if (!canManage && !isInstructor) {
    throw new NotFoundException({ messageKey: 'errors.notFound' });
  }

  return course.academyId;
}

export interface CourseReviewContext {
  readonly academyId: string;
  /** `instructor` when the caller reviews as the course's assigned instructor; otherwise the academy role. */
  readonly reviewerRole: 'instructor' | 'owner' | 'administrator' | 'manager';
}

/**
 * P64 Phase 1 — the review/grading tier (RBAC matrix rows "view attempts,
 * answers, submissions" and "grade"): the course's assigned instructor OR
 * the owning academy's active owner/administrator/manager. Mirrors
 * `can_review_course()` (P64 migration) exactly — every `review/*`
 * endpoint runs this first and the RLS review policies independently
 * agree, so an instructor of another course, a plain organization member,
 * academy `staff`, or a student all get 404 here and zero rows there.
 */
export async function assertCanReviewCourse(
  tx: Prisma.TransactionClient,
  coursesRepository: CoursesRepository,
  academyMembersRepository: AcademyMembersRepository,
  courseInstructorsRepository: CourseInstructorsRepository,
  userId: string,
  courseId: string,
): Promise<CourseReviewContext> {
  const course = await coursesRepository.findById(tx, courseId);
  if (!course) {
    throw new NotFoundException({ messageKey: 'errors.notFound' });
  }

  const [membership, isInstructor] = await Promise.all([
    academyMembersRepository.findForUserInAcademy(tx, course.academyId, userId),
    courseInstructorsRepository.isInstructor(tx, courseId, userId),
  ]);

  if (isInstructor) {
    return { academyId: course.academyId, reviewerRole: 'instructor' };
  }
  if (
    membership &&
    membership.status === 'active' &&
    MANAGING_ROLES.has(membership.role)
  ) {
    return {
      academyId: course.academyId,
      reviewerRole: membership.role as 'owner' | 'administrator' | 'manager',
    };
  }

  throw new NotFoundException({ messageKey: 'errors.notFound' });
}

/**
 * P64 Phase 1 (D8) — security-sensitive academy policies (registration
 * policy, content protection, device/session enforcement) are the Client
 * Owner's alone; a Manager's academy-wide operational authority does not
 * extend to them. Kept separate from the managing-roles set on purpose so
 * the two can never be collapsed by accident.
 */
export async function assertCanManageSecurityPolicy(
  tx: Prisma.TransactionClient,
  academyMembersRepository: AcademyMembersRepository,
  academyId: string,
  userId: string,
): Promise<void> {
  const membership = await academyMembersRepository.findForUserInAcademy(
    tx,
    academyId,
    userId,
  );
  if (!membership || membership.status !== 'active' || membership.role !== 'owner') {
    throw new ForbiddenException({ messageKey: 'errors.academy.insufficientRole' });
  }
}
