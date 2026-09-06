/** `ContactSubmission` response contract — Phase 6. Matches `contact.types.ts` (atlas frontend) field-for-field. */
import type { ContactSubmission as PrismaContactSubmission } from '@prisma/client';

export interface ContactSubmissionResponse {
  readonly id: string;
  readonly academyId: string;
  readonly name: string;
  readonly email: string;
  readonly message: string;
  readonly status: PrismaContactSubmission['status'];
  readonly createdAt: string;
}

export function toContactSubmissionResponse(
  submission: PrismaContactSubmission,
): ContactSubmissionResponse {
  return {
    id: submission.id,
    academyId: submission.academyId,
    name: submission.name,
    email: submission.email,
    message: submission.message,
    status: submission.status,
    createdAt: submission.createdAt.toISOString(),
  };
}
