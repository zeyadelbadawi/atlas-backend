/**
 * `AcademyStudent` response contract — the account
 * `AcademiesService.createStudent` just created. Still deliberately NOT
 * shaped like `AcademyMemberResponse` (no `role`/`status`/`joinedAt` — a
 * student is never an `academy_members` row) — but `academyId` is now
 * included (Phase 1, Extended Scope, Decision 11, dependency D): the
 * created account genuinely has one, via the new `academy_students` row
 * `AcademiesService.createStudent` creates alongside the user.
 */
import type { User } from '@prisma/client';

export interface AcademyStudentResponse {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly academyId: string;
  readonly createdAt: string;
}

export function toAcademyStudentResponse(
  user: User,
  academyId: string,
): AcademyStudentResponse {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    academyId,
    createdAt: user.createdAt.toISOString(),
  };
}
