/**
 * Shared "does this student have real access to this course's content"
 * check — used by `CourseProgressService`/`QuizzesService`/
 * `AssignmentsService`, every one of which gates on the exact same fact:
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
