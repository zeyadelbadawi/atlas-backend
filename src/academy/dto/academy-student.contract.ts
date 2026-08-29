/**
 * `AcademyStudent` response contract — the account
 * `AcademiesService.createStudent` just created. Deliberately NOT shaped
 * like `AcademyMemberResponse` (no `academyId`/`role`/`status`/`joinedAt`)
 * because a student is never an `academy_members` row — see that
 * method's doc comment.
 */
import type { User } from '@prisma/client';

export interface AcademyStudentResponse {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly createdAt: string;
}

export function toAcademyStudentResponse(user: User): AcademyStudentResponse {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
  };
}
