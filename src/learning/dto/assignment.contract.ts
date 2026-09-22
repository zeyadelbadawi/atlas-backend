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
  /** P64 Phase 3 — `block` refuses late work; `accept_flagged` accepts and marks it late. */
  readonly latePolicy: PrismaAssignment['latePolicy'];
  readonly requiredForCompletion: boolean;
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
    latePolicy: assignment.latePolicy,
    requiredForCompletion: assignment.requiredForCompletion,
  };
}
