/**
 * `AcademyMember` response contract — matches `academy.types.ts` exactly.
 * `name`/`email` are resolved via the `users` join at query time (see
 * `AcademyMembersRepository.findManyForAcademy`), never duplicated onto
 * `academy_members` — matching this repo's `AcademyMember` Prisma model's
 * own doc comment.
 */
import type { AcademyMemberWithUser } from '../repositories/academy-members.repository';

export interface AcademyMemberResponse {
  readonly id: string;
  readonly academyId: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: AcademyMemberWithUser['role'];
  readonly status: AcademyMemberWithUser['status'];
  readonly joinedAt: string;
}

export function toAcademyMemberResponse(
  member: AcademyMemberWithUser,
): AcademyMemberResponse {
  return {
    id: member.id,
    academyId: member.academyId,
    userId: member.userId,
    name: member.user.name,
    email: member.user.email,
    role: member.role,
    status: member.status,
    joinedAt: member.joinedAt.toISOString(),
  };
}

/**
 * Smart member invitation — what an add actually did, so the dialog can
 * confirm the right thing:
 *  - `invited`: a new (invited) Atlas account was created and sent a setup link;
 *  - `reinvited`: the email belonged to an account that never finished setup,
 *    so a fresh setup link was sent;
 *  - `added`: an existing, active account was added and told so.
 */
export type MemberAddOutcome = 'invited' | 'reinvited' | 'added';

export type AcademyMemberAddResponse = AcademyMemberResponse & {
  readonly outcome: MemberAddOutcome;
};
