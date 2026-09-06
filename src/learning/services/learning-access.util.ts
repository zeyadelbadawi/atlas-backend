/**
 * Shared course-access checks, used by `CourseProgressService`/
 * `QuizzesService`/`AssignmentsService`. `assertActiveEnrollment`/
 * `assertCourseReadAccess` answer "does this student/instructor have real
 * access to this course's content"; `assertCanAuthorCourseContent`
 * (Phase 4, P24) answers the separate, narrower "may this caller WRITE
 * this course's quiz/assignment content" question. `assertActiveEnrollment`
 * gates on the exact same fact:
 * an active (`enrolled`/`completed`) `Enrollment` row for this student and
 * course. A course's current visibility/status is deliberately NOT
 * re-checked here — once enrolled, access is governed by the enrollment
 * itself, not by whether the academy later archives the course for new
 * students (no frontend contract asks for access revocation on archive,
 * and inventing one would be exactly the kind of unrequested business
 * rule this phase must not add).
 *
 * A missing/inactive enrollment surfaces as 404, not 403 — matches the
 * "draft/unreachable content looks like it doesn't exist" pattern already
 * established for academy-scoped content (courses, website pages) rather
 * than confirming to an unauthorized caller that a course/enrollment
 * exists at all.
 */
import { NotFoundException } from '@nestjs/common';
import type { Enrollment, Prisma } from '@prisma/client';
import { ACTIVE_ENROLLMENT_STATUSES } from '../dto/learning.constants';
import type { EnrollmentsRepository } from '../repositories/enrollments.repository';
import type { CourseInstructorsRepository } from '../../course/repositories/course-instructors.repository';
import type { CoursesRepository } from '../../course/repositories/courses.repository';
import type { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';

export async function assertActiveEnrollment(
  tx: Prisma.TransactionClient,
  enrollmentsRepository: EnrollmentsRepository,
  studentId: string,
  courseId: string,
): Promise<Enrollment> {
  const enrollment = await enrollmentsRepository.findByStudentAndCourse(
    tx,
    studentId,
    courseId,
  );
  if (
    !enrollment ||
    !(ACTIVE_ENROLLMENT_STATUSES as readonly string[]).includes(enrollment.status)
  ) {
    throw new NotFoundException({ messageKey: 'errors.notFound' });
  }
  return enrollment;
}

/**
 * Read-access check for the two quiz/assignment *definition* read paths
 * (`getQuizzes`/`getQuiz`, `getAssignments`/`getAssignment`) — deliberately
 * broader than `assertActiveEnrollment`: an authorized instructor reads
 * these through the exact same P6 endpoints a student does (confirmed
 * against the real frontend — `InstructorAssessmentsPage`/
 * `InstructorQuizResultsPage` call `useQuizzes`/`useQuiz`/`useAssignments`
 * from `@features/learning`, the P6 hooks, not a duplicate P7 endpoint;
 * `instructor.types.ts`'s own doc comment: "quiz/assignment definitions
 * are identical regardless of viewer role"). Attempt/submission actions
 * (`startAttempt`/`submitAttempt`/`submitAssignment`) stay on
 * `assertActiveEnrollment` alone, unchanged — only a real student ever
 * takes a quiz or submits an assignment, never an instructor.
 *
 * Backed by the additive `*_instructor_select` RLS policies (P7
 * migration) — this check and those policies must agree, or an instructor
 * would pass this check and still get an RLS-empty result (or vice versa,
 * which RLS would silently prevent from ever mattering).
 */
export async function assertCourseReadAccess(
  tx: Prisma.TransactionClient,
  enrollmentsRepository: EnrollmentsRepository,
  courseInstructorsRepository: CourseInstructorsRepository,
  userId: string,
  courseId: string,
): Promise<void> {
  const [enrollment, isInstructor] = await Promise.all([
    enrollmentsRepository.findByStudentAndCourse(tx, userId, courseId),
    courseInstructorsRepository.isInstructor(tx, courseId, userId),
  ]);
  const hasActiveEnrollment =
    !!enrollment &&
    (ACTIVE_ENROLLMENT_STATUSES as readonly string[]).includes(enrollment.status);

  if (!hasActiveEnrollment && !isInstructor) {
    throw new NotFoundException({ messageKey: 'errors.notFound' });
  }
}

/** See `AcademiesService.MANAGING_ROLES`/`CoursesService.MANAGING_ROLES` — identical rule. */
const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

/**
 * Write-authorization check for Quiz/Assignment authoring (Phase 4, P24):
 * the course's own assigned instructor(s), OR the owning academy's
 * owner/administrator/manager — matches `can_author_course_content()`
 * (the P24 migration's RLS function) exactly; the two must agree, same
 * discipline `assertCourseReadAccess`'s own doc comment documents for its
 * RLS counterpart. Deliberately narrower than `assertCourseReadAccess`:
 * an enrolled student can read a quiz/assignment but never author one.
 *
 * Returns the course's `academyId` — every caller needs it next (to
 * resolve `sectionId ` against the right course, or simply because the
 * caller already has the course row and this saves a second lookup).
 *
 * A missing course or a real user with no authoring relationship to it
 * both surface as 404, matching `assertCourseReadAccess`'s identical
 * "never confirm existence to an unauthorized caller" discipline — this
 * is the exact same flat, guard-less `courses/:id/...` route shape
 * (`QuizzesController`/`AssignmentsController`), not the academy-scoped,
 * already-guarded shape `CoursesService.assertCanManage` runs behind.
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
