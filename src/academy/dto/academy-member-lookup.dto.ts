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
 * The whole response. Deliberately minimal: a status, and — only when an
 * account exists and could be added — its display name. Never a user id,
 * an email, organizations, other academies or roles elsewhere.
 */
export type AcademyMemberLookupResponse =
  | { readonly status: 'new' }
  | { readonly status: 'existing'; readonly name: string }
  | { readonly status: 'existing_pending_setup'; readonly name: string }
  | { readonly status: 'already_member' }
  | { readonly status: 'unavailable' };
