/**
 * `Enrollment` response contract — matches `enrollment.types.ts`
 * field-for-field.
 */
import type { Enrollment as PrismaEnrollment } from '@prisma/client';

export interface EnrollmentResponse {
  readonly id: string;
  readonly studentId: string;
  readonly courseId: string;
  readonly academyId: string;
  readonly status: PrismaEnrollment['status'];
  readonly enrolledAt?: string;
  readonly completedAt?: string;
}

export function toEnrollmentResponse(enrollment: PrismaEnrollment): EnrollmentResponse {
  return {
    id: enrollment.id,
    studentId: enrollment.studentId,
    courseId: enrollment.courseId,
    academyId: enrollment.academyId,
    status: enrollment.status,
    enrolledAt: enrollment.enrolledAt?.toISOString(),
    completedAt: enrollment.completedAt?.toISOString(),
  };
}
