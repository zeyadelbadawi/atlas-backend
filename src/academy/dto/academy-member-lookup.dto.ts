/**
 * `GET /academies/:id/member-lookup` — the staff invitation dialog's email
 * lookup. UX only: the add call re-resolves the email inside its own
 * transaction and never trusts this answer.
 */
import { IsEmail, IsIn, IsNotEmpty } from 'class-validator';

export const MEMBER_LOOKUP_ROLES = ['manager', 'instructor', 'student'] as const;
export type MemberLookupRole = (typeof MEMBER_LOOKUP_ROLES)[number];

export class AcademyMemberLookupQueryDto {
  @IsNotEmpty()
  @IsEmail()
  readonly email!: string;

  @IsIn(MEMBER_LOOKUP_ROLES)
  readonly role!: MemberLookupRole;
}

/**
 * The whole response — about THIS academy only (ATO review F5).
 *
 *  - `already_member`: the address already belongs to someone in this
 *    academy (the owner can already see them in the member list);
 *  - `new`: anything else — no account, an account elsewhere on Atlas, a
 *    suspended or deleted one. The dialog asks for a name either way.
 *
 * It never says whether the address has an Atlas account, never returns a
 * name, and so cannot be used to look up who uses Atlas. (`new` keeps the
 * literal the dialog has always treated as "ask for a name".)
 */
export type AcademyMemberLookupResponse =
  { readonly status: 'new' } | { readonly status: 'already_member' };
