/** `Assignment` response contract — matches `assignment.types.ts` field-for-field. */
import type { Assignment as PrismaAssignment } from '@prisma/client';

export interface AssignmentResponse {
  readonly id: string;
  readonly courseId: string;
  readonly sectionId?: string;
  readonly lessonId?: string;
  readonly title: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly status: PrismaAssignment['status'];
  readonly dueAt?: string;
  readonly allowResubmission: boolean;
}

export function toAssignmentResponse(assignment: PrismaAssignment): AssignmentResponse {
  return {
    id: assignment.id,
    courseId: assignment.courseId,
    sectionId: assignment.sectionId ?? undefined,
    lessonId: assignment.lessonId ?? undefined,
    title: assignment.title,
    description: assignment.description ?? undefined,
    instructions: assignment.instructions ?? undefined,
    status: assignment.status,
    dueAt: assignment.dueAt?.toISOString(),
    allowResubmission: assignment.allowResubmission,
  };
}
